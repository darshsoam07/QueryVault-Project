/**
 * QueryVault Safe Provider Migration & Reindexing Tool
 *
 * Usage:
 *   npx tsx scripts/reindex.ts [--all] [--drain]
 *
 * When switching AI providers (e.g. from OpenAI to Google Gemini), existing
 * embeddings live in a different vector space than new query vectors.
 * To avoid mixing incompatible embedding spaces in similarity search, this
 * script identifies documents indexed with a different model and queues
 * durable 'reindex' jobs.
 *
 * Guarantees:
 * 1. Zero document loss: original files in private Supabase Storage are preserved.
 * 2. Tenant isolation: each job preserves document ownership (user_id).
 * 3. Idempotent upsert: deterministic chunk IDs overwrite existing chunk vectors.
 * 4. Zero schema changes: retains the halfvec(3072) column definition.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { requireAiProvider, EMBEDDING_DIMENSIONS } from "../src/lib/ai-gateway.server";

// Parse .env directly into process.env if not already set
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

async function main() {
  const supabaseUrl = process.env["SUPABASE_URL"];
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];

  if (!supabaseUrl || !serviceKey) {
    console.error("[reindex] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const provider = requireAiProvider();
  console.log(`[reindex] Active AI provider: ${provider.label} (${provider.id})`);
  console.log(`[reindex] Target embedding model: ${provider.embeddingModel}`);
  console.log(
    `[reindex] Vector dimension: ${provider.embeddingDimensions} (matches schema halfvec(${EMBEDDING_DIMENSIONS}))`,
  );

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const shouldReindexAll = process.argv.includes("--all");
  const shouldDrain = process.argv.includes("--drain");

  // Query documents
  let query = supabaseAdmin
    .from("documents")
    .select("id, user_id, filename, status, phase, embedding_model, chunk_count")
    .neq("status", "deleting");

  if (!shouldReindexAll) {
    // Only target documents not yet indexed with this provider's model
    query = query.or(`embedding_model.is.null,embedding_model.neq.${provider.embeddingModel}`);
  }

  const { data: docs, error } = await query;
  if (error) {
    console.error("[reindex] Failed to fetch documents:", error.message);
    process.exit(1);
  }

  if (!docs || docs.length === 0) {
    console.log(
      "[reindex] All ready documents are already indexed with the active model. Nothing to migrate.",
    );
    return;
  }

  console.log(`[reindex] Found ${docs.length} document(s) requiring reindexing.`);

  let queuedCount = 0;
  for (const doc of docs) {
    // Check if an in-flight job already exists
    const { data: liveJob } = await supabaseAdmin
      .from("ingestion_jobs")
      .select("id, status")
      .eq("document_id", doc.id)
      .in("status", ["queued", "running", "retrying"])
      .maybeSingle();

    if (liveJob) {
      console.log(
        `[reindex] Document ${doc.id} (${doc.filename}) already has active job ${liveJob.id} (${liveJob.status}). Skipping queue.`,
      );
      continue;
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from("ingestion_jobs")
      .insert({
        document_id: doc.id,
        user_id: doc.user_id,
        status: "queued",
        kind: "reindex",
      })
      .select("id")
      .single();

    if (jobError || !job) {
      console.error(`[reindex] Failed to queue job for document ${doc.id}:`, jobError?.message);
      continue;
    }

    // Reset document phase to queued
    await supabaseAdmin
      .from("documents")
      .update({
        phase: "queued",
        progress: 5,
        failure_code: null,
        failure_message: null,
        error_message: null,
      })
      .eq("id", doc.id);

    queuedCount++;
    console.log(
      `[reindex] Queued reindex job ${job.id} for document ${doc.id} ("${doc.filename}", owner: ${doc.user_id}).`,
    );
  }

  console.log(`[reindex] Successfully queued ${queuedCount} reindex job(s).`);

  if (shouldDrain && queuedCount > 0) {
    console.log("[reindex] Immediate drain requested (--drain). Draining jobs...");
    const { drainIngestionJobs } = await import("../src/lib/ingestion/worker.server");
    const result = await drainIngestionJobs({ maxJobs: queuedCount });
    console.log(
      `[reindex] Drain completed: succeeded=${result.succeeded}, retrying=${result.retrying}, failed=${result.failed}.`,
    );
  } else {
    console.log(
      "[reindex] Ingestion worker will process queued jobs during its regular drain loop (`npm run worker`).",
    );
  }
}

if (process.env["NODE_ENV"] !== "test") {
  main().catch((err) => {
    console.error("[reindex] Fatal error:", err);
    process.exit(1);
  });
}
