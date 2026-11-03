import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/integrations/supabase/types";
import {
  assertLocalConfig,
  assertContainer,
  configureEnvironment,
  restrictedFetch,
  type LocalConfig,
} from "./isolation";
import type { Loaded } from "./load";
import { sha256 } from "./load";
import { locate, type LocatedChunk } from "./metrics";
import { ownerScopedPath, safeFilename } from "../../src/lib/documents.policy";
import type { EvidenceSource } from "../../src/lib/retrieval/types";

function data<T>(result: { data: T; error: unknown }): NonNullable<T> {
  if (result.error || result.data === null || result.data === undefined)
    throw new Error("LOCAL_SERVICE_OPERATION_FAILED");
  return result.data;
}
export async function connectIsolated(config: LocalConfig, loaded: Loaded, live: boolean) {
  assertLocalConfig(config, live);
  if (loaded.manifest.documents.some((d) => !d.provenance.providerUseAllowed))
    throw new Error("DOCUMENT_PROVIDER_PERMISSION_REQUIRED");
  for (const service of ["kong", "db"]) {
    const name = `supabase_${service}_queryvault-benchmark`;
    const inspection = JSON.parse(
      execFileSync("docker", ["inspect", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      }),
    )[0];
    assertContainer(
      inspection,
      name,
      service === "kong" ? new URL(config.supabaseUrl).port : undefined,
    );
  }
  configureEnvironment(config);
  const { requireAiProvider } = await import("../../src/lib/ai-gateway.server");
  const provider = requireAiProvider();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = restrictedFetch(originalFetch, config.supabaseUrl, provider.baseUrl);
  const { createSupabaseFetch } = await import("../../src/integrations/supabase/api-key");
  const admin = createClient<Database>(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: createSupabaseFetch(config.serviceRoleKey) },
  });
  // Refuse before creating anything. A new stack is required for every run.
  try {
    for (const table of ["documents", "ingestion_jobs", "threads", "messages"] as const) {
      const rows = data(await admin.from(table).select("id").limit(1));
      if (rows.length) throw new Error("BENCHMARK_DATABASE_NOT_EMPTY");
    }
    const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (listed.error) throw new Error("LOCAL_SERVICE_OPERATION_FAILED");
    if (listed.data.users.length) throw new Error("BENCHMARK_AUTH_NOT_EMPTY");
    if (data(await admin.storage.from("documents").list("", { limit: 1 })).length)
      throw new Error("BENCHMARK_STORAGE_NOT_EMPTY");
    const email = `benchmark-${randomUUID()}@example.test`,
      password = `${randomUUID()}Aa!`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw new Error("LOCAL_SERVICE_OPERATION_FAILED");
    const user = created.data.user;
    if (!user) throw new Error("BENCHMARK_USER_UNAVAILABLE");
    const auth = createClient<Database>(config.supabaseUrl, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: createSupabaseFetch(config.publishableKey) },
    });
    const signedIn = await auth.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw new Error("LOCAL_SERVICE_OPERATION_FAILED");
    const session = signedIn.data.session;
    if (!session) throw new Error("BENCHMARK_SESSION_UNAVAILABLE");
    const { createUserScopedClient } =
      await import("../../src/integrations/supabase/verify-token.server");
    const client = createUserScopedClient(session.access_token);
    const { drainIngestionJobs } = await import("../../src/lib/ingestion/worker.server");
    const { createLiveDeps, runRetrieval } = await import("../../src/lib/retrieval/pipeline");
    const { PARSER_VERSION } = await import("../../src/lib/ingestion/contract");
    const documentIds = new Map<string, string>();
    const indexed: LocatedChunk[] = [];
    for (const doc of loaded.manifest.documents) {
      const filename = safeFilename(basename(loaded.files.get(doc.id)!));
      const bytes = await readFile(loaded.files.get(doc.id)!);
      if (sha256(bytes) !== doc.sha256) throw new Error("DOCUMENT_CHANGED_BEFORE_INGESTION");
      // Same reservation -> private Storage -> authenticated queue -> production
      // worker path. Browser/server-function upload transport is not benchmarked.
      const reserved = data(
        await admin
          .from("documents")
          .insert({
            user_id: user.id,
            filename,
            byte_size: bytes.length,
            content_hash: doc.sha256,
            status: "uploaded",
            phase: "uploading",
            progress: 0,
            parser_version: PARSER_VERSION,
            content_type: "application/octet-stream",
          })
          .select("id")
          .single(),
      );
      documentIds.set(doc.id, reserved.id);
      data(
        await client.storage
          .from("documents")
          .upload(ownerScopedPath(user.id, reserved.id, filename), bytes, {
            contentType: "application/octet-stream",
            upsert: false,
          }),
      );
      data(
        await client
          .from("ingestion_jobs")
          .insert({ document_id: reserved.id, user_id: user.id, status: "queued", kind: "ingest" })
          .select("id")
          .single(),
      );
      const result = await drainIngestionJobs({ userId: user.id, maxJobs: 1 });
      if (result.succeeded !== 1) throw new Error("PRODUCTION_INGESTION_INCOMPLETE");
      const published = data(
        await client.from("documents").select("status").eq("id", reserved.id).single(),
      );
      if (published.status !== "ready") throw new Error("DOCUMENT_NOT_READY");
      // Paginate, rather than silently truncating at PostgREST's default limit.
      for (let offset = 0; ; offset += 500) {
        const chunks = data(
          await client
            .from("document_chunks")
            .select("id,content,page_number")
            .eq("document_id", reserved.id)
            .order("chunk_index")
            .range(offset, offset + 499),
        );
        for (const c of chunks)
          indexed.push(
            locate(
              { chunkId: c.id, documentId: doc.id, page: c.page_number, content: c.content },
              loaded.pages.get(doc.id)!,
            ),
          );
        if (chunks.length < 500) break;
      }
    }
    const originalId = (runtimeId: string) =>
      [...documentIds].find(([, id]) => id === runtimeId)?.[0];
    const locateSource = (s: {
      chunkId: string;
      documentId: string;
      page: number;
      content: string;
    }) => {
      const id = originalId(s.documentId);
      if (!id) throw new Error("FOREIGN_RETRIEVAL_DOCUMENT");
      return locate({ ...s, documentId: id }, loaded.pages.get(id)!);
    };
    return {
      indexed,
      documentIds: Object.fromEntries(documentIds),
      provider: {
        id: provider.id,
        chatModel: provider.chatModel,
        embeddingModel: provider.embeddingModel,
        utilityModel: provider.utilityModel,
        embeddingDimensions: provider.embeddingDimensions,
        providerModelRevision: null,
      },
      async retrieve(question: string) {
        const outcome = await runRetrieval(
          question,
          createLiveDeps({
            client,
            userId: user.id,
            documentIds: [...documentIds.values()],
            provider,
            signal: AbortSignal.timeout(90_000),
          }),
        );
        return {
          ranked: outcome.ranked.map(locateSource),
          context: outcome.context.sources.map((s) => locateSource({ ...s, content: s.snippet })),
          telemetry: outcome.telemetry,
          refused: !outcome.verdict.grounded,
        };
      },
      async generate(question: string) {
        const thread = data(
          await client
            .from("threads")
            .insert({ user_id: user.id, title: "Private benchmark question" })
            .select("id")
            .single(),
        );
        const { Route } = await import("../../src/routes/api/chat");
        const post = (
          Route as unknown as {
            options: {
              server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } };
            };
          }
        ).options.server.handlers.POST;
        const response = await post({
          request: new Request("http://127.0.0.1/api/chat", {
            method: "POST",
            headers: {
              authorization: `Bearer ${session.access_token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              threadId: thread.id,
              documentIds: [...documentIds.values()],
              messages: [{ role: "user", parts: [{ type: "text", text: question }] }],
            }),
            signal: AbortSignal.timeout(120_000),
          }),
        });
        if (!response.ok) throw new Error(`CHAT_HTTP_${response.status}`);
        const stream = await response.text();
        let answer = "",
          finished = false;
        let citations: EvidenceSource[] = [];
        for (const line of stream.split(/\r?\n/)) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") {
            finished = true;
            continue;
          }
          const event = JSON.parse(payload);
          if (event.type === "error") throw new Error("CHAT_STREAM_ERROR");
          if (event.type === "text-delta") answer += event.delta;
          if (event.type === "data-sources") citations = event.data;
        }
        if (!finished || !answer.trim()) throw new Error("CHAT_STREAM_INCOMPLETE");
        const { GROUNDED_REFUSAL } = await import("../../src/lib/chat.schema");
        return {
          answer,
          refused: answer.trim() === GROUNDED_REFUSAL,
          citations,
          citedSpans: citations.map((s) => locateSource({ ...s, content: s.snippet })),
          contextScope: "production-chat-returned-citations-only",
          tokenUsage: null,
          tokenUsageStatus: "unavailable: chat route does not expose usage",
          fullGenerationContextStatus: "unavailable: retrieval reruns inside production chat",
        };
      },
      close() {
        globalThis.fetch = originalFetch;
      },
    };
  } catch (error) {
    globalThis.fetch = originalFetch;
    throw error;
  }
}
