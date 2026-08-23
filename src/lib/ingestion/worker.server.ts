/**
 * Server-authoritative ingestion worker.
 *
 * Owns the entire pipeline: storage download -> validation -> parse -> chunk ->
 * embed -> index -> final state transition. The browser never contributes
 * chunks, embeddings or completion signals.
 *
 * Every step is idempotent: chunk ids are derived from (document, version,
 * position), writes are upserts, and stale-version chunks are pruned before a
 * document is marked ready. A crashed attempt is reclaimed by the next drain.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  GatewayError,
  embedTexts,
  requireAiProvider,
  toVectorLiteral,
} from "@/lib/ai-gateway.server";
import { logEvent, newRequestId } from "@/lib/api-errors";
import { EVENTS } from "@/lib/observability/events";
import { emitAsync } from "@/lib/observability/telemetry.server";
import { batchArray, preparePageChunks, type PageText } from "@/lib/chunking";
import {
  MAX_UPLOAD_BYTES,
  MIN_UPLOAD_BYTES,
  hasPdfMagicBytes,
  isAllowedContentType,
  ownerScopedPath,
} from "@/lib/documents.policy";
import {
  CHUNKER_VERSION,
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  EMBED_BATCH,
  PARSER_VERSION,
  WORKER_VERSION,
  backoffSeconds,
  classifyError,
  dependency,
  deterministicChunkId,
  isRetryable,
  permanent,
  type IngestionPhase,
} from "./contract";

type Admin = SupabaseClient<Database>;
type Job = Database["public"]["Tables"]["ingestion_jobs"]["Row"];

const LOCK_SECONDS = 300;

class JobCancelled extends Error {}

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as Admin;
}

async function setPhase(
  db: Admin,
  job: Job,
  phase: IngestionPhase,
  patch: Partial<Database["public"]["Tables"]["documents"]["Update"]> = {},
): Promise<void> {
  await db
    .from("documents")
    .update({ phase, ...patch })
    .eq("id", job.document_id)
    .eq("user_id", job.user_id)
    .neq("status", "deleting");
}

/** Moves `documents.status` along the legal path towards `target`. */
async function advanceStatus(db: Admin, job: Job, target: "processing"): Promise<void> {
  const { data: doc } = await db
    .from("documents")
    .select("status")
    .eq("id", job.document_id)
    .eq("user_id", job.user_id)
    .maybeSingle();
  if (!doc) throw new JobCancelled("document removed");
  if (doc.status === "deleting") throw new JobCancelled("document is being deleted");

  const path: string[] = [];
  if (doc.status === "uploaded" || doc.status === "failed") path.push("validating", "stored");
  else if (doc.status === "validating") path.push("stored");
  path.push(target);

  for (const status of path) {
    if (status === doc.status) continue;
    const { error } = await db
      .from("documents")
      .update({ status })
      .eq("id", job.document_id)
      .eq("user_id", job.user_id)
      .neq("status", "deleting");
    if (error) throw permanent("ILLEGAL_TRANSITION", "The document is in an unexpected state.");
  }
}

/** Throws if the document disappeared or entered deletion mid-run. */
async function assertLive(db: Admin, job: Job): Promise<void> {
  const { data } = await db
    .from("documents")
    .select("status")
    .eq("id", job.document_id)
    .eq("user_id", job.user_id)
    .maybeSingle();
  if (!data) throw new JobCancelled("document removed");
  if (data.status === "deleting") throw new JobCancelled("document is being deleted");
}

async function extractPages(bytes: Uint8Array): Promise<PageText[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  try {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [String(text)];
    return pages.map((value, index) => ({ page: index + 1, text: value ?? "" }));
  } catch {
    throw permanent("PARSE_FAILED", "That PDF could not be read. It may be corrupt or encrypted.");
  }
}

/* ------------------------------ the pipeline ------------------------------ */

async function processJob(db: Admin, job: Job, requestId: string): Promise<{ chunks: number }> {
  const storagePath = ownerScopedPath(job.user_id, job.document_id);
  const startedAt = Date.now();
  emitAsync({
    event: EVENTS.INGESTION_STARTED,
    requestId,
    status: "started",
    userId: job.user_id,
    documentId: job.document_id,
    attributes: { job_id: job.id, attempt: job.attempt_count, worker_version: WORKER_VERSION },
  });

  // ---- validate --------------------------------------------------------
  await assertLive(db, job);
  await setPhase(db, job, "validating", { progress: 10 });

  const { data: blob, error: downloadError } = await db.storage
    .from("documents")
    .download(storagePath);
  if (downloadError || !blob) {
    throw permanent("MISSING_OBJECT", "The uploaded file could not be read. Upload it again.");
  }
  if (blob.size < MIN_UPLOAD_BYTES) throw permanent("EMPTY_FILE", "That PDF is empty.");
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw permanent(
      "TOO_LARGE",
      `PDFs must be smaller than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    );
  }
  if (blob.type && !isAllowedContentType(blob.type)) {
    throw permanent("BAD_CONTENT_TYPE", "Only PDF files can be indexed.");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!hasPdfMagicBytes(bytes)) throw permanent("NOT_A_PDF", "That file is not a valid PDF.");

  await db
    .from("documents")
    .update({ storage_path: storagePath, byte_size: blob.size })
    .eq("id", job.document_id)
    .eq("user_id", job.user_id);

  // ---- parse -----------------------------------------------------------
  await assertLive(db, job);
  await setPhase(db, job, "parsing", { progress: 25 });
  const pages = await extractPages(bytes);
  const textLength = pages.reduce((sum, page) => sum + page.text.trim().length, 0);
  if (textLength < 40) {
    throw permanent(
      "NO_TEXT_LAYER",
      "No selectable text found. Scanned PDFs need OCR before upload.",
    );
  }

  // ---- chunk -----------------------------------------------------------
  await advanceStatus(db, job, "processing");
  await setPhase(db, job, "chunking", { progress: 40, page_count: pages.length });
  const chunks = preparePageChunks(pages, CHUNK_SIZE, CHUNK_OVERLAP);
  if (chunks.length === 0) {
    throw permanent("NO_CHUNKS", "This document produced no usable text.");
  }

  // ---- embed + index ---------------------------------------------------
  const provider = requireAiProvider();
  const batches = batchArray(chunks, EMBED_BATCH);
  let indexed = 0;

  for (const batch of batches) {
    await assertLive(db, job);
    await setPhase(db, job, "embedding", {
      progress: 40 + Math.round((indexed / chunks.length) * 45),
    });

    let embeddings: number[][];
    try {
      embeddings = await embedTexts(
        batch.map((chunk) => chunk.content),
        provider,
      );
    } catch (error) {
      if (error instanceof GatewayError) {
        throw error.status === 429 || error.status === 402
          ? classifyError(error)
          : dependency("EMBEDDING_FAILED", error.message);
      }
      throw dependency("EMBEDDING_FAILED", "The embedding service did not respond.");
    }

    await setPhase(db, job, "indexing");
    const rows = await Promise.all(
      batch.map(async (chunk, i) => ({
        id: await deterministicChunkId(job.document_id, CHUNKER_VERSION, chunk.index),
        document_id: job.document_id,
        user_id: job.user_id,
        content: chunk.content,
        page_number: chunk.page,
        chunk_index: chunk.index,
        token_estimate: Math.ceil(chunk.content.length / 4),
        embedding: toVectorLiteral(embeddings[i]!),
        chunking_version: CHUNKER_VERSION,
        embedding_model: provider.embeddingModel,
      })),
    );

    // Deterministic ids + upsert = a retried batch overwrites, never duplicates.
    const { error: upsertError } = await db
      .from("document_chunks")
      .upsert(rows, { onConflict: "id" });
    if (upsertError) {
      throw dependency("CHUNK_WRITE_FAILED", "Storing the index failed. Retrying shortly.");
    }

    indexed += rows.length;
    await db
      .from("documents")
      .update({ chunk_count: indexed })
      .eq("id", job.document_id)
      .eq("user_id", job.user_id);
  }

  // ---- finalise --------------------------------------------------------
  await assertLive(db, job);
  await setPhase(db, job, "indexing", { progress: 95 });
  // Anything from an older pipeline version or a longer previous run must go
  // before the document can be trusted as READY.
  await db.rpc("prune_stale_chunks", {
    target_document_id: job.document_id,
    keep_chunking_version: CHUNKER_VERSION,
    keep_max_index: chunks.length - 1,
  });

  const { error: readyError } = await db
    .from("documents")
    .update({
      status: "ready",
      phase: "ready",
      progress: 100,
      chunk_count: chunks.length,
      page_count: pages.length,
      parser_version: PARSER_VERSION,
      chunking_version: CHUNKER_VERSION,
      embedding_model: provider.embeddingModel,
      embedding_dimension: provider.embeddingDimensions,
      completed_at: new Date().toISOString(),
      failure_code: null,
      failure_message: null,
      error_message: null,
    })
    .eq("id", job.document_id)
    .eq("user_id", job.user_id)
    .eq("status", "processing");

  if (readyError) {
    throw dependency("FINALIZE_FAILED", "Could not mark the document ready. Retrying shortly.");
  }

  emitAsync({
    event: EVENTS.INGESTION_COMPLETED,
    requestId,
    status: "ok",
    userId: job.user_id,
    documentId: job.document_id,
    latencyMs: Date.now() - startedAt,
    attributes: {
      job_id: job.id,
      attempt: job.attempt_count,
      chunks: chunks.length,
      pages: pages.length,
      duration_ms: Date.now() - startedAt,
      embedding_calls: Math.ceil(chunks.length / EMBED_BATCH),
      embedded_texts: chunks.length,
      parser_version: PARSER_VERSION,
      chunking_version: CHUNKER_VERSION,
      embedding_model: provider.embeddingModel,
    },
  });
  return { chunks: chunks.length };
}

/* ------------------------------- job driver ------------------------------- */

async function finishJob(db: Admin, job: Job): Promise<void> {
  await db
    .from("ingestion_jobs")
    .update({
      status: "succeeded",
      completed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      error_code: null,
      error_message: null,
    })
    .eq("id", job.id);
}

async function failJob(
  db: Admin,
  job: Job,
  code: string,
  message: string,
  retry: { delaySeconds: number } | null,
  requestId: string,
): Promise<void> {
  const now = Date.now();
  if (retry) {
    await db
      .from("ingestion_jobs")
      .update({
        status: "retrying",
        available_at: new Date(now + retry.delaySeconds * 1000).toISOString(),
        locked_at: null,
        locked_by: null,
        error_code: code,
        error_message: message.slice(0, 500),
      })
      .eq("id", job.id);
    emitAsync({
      event: EVENTS.INGESTION_RETRYING,
      requestId,
      status: "retrying",
      errorCode: code,
      userId: job.user_id,
      documentId: job.document_id,
      attributes: { job_id: job.id, attempt: job.attempt_count, retry_in_s: retry.delaySeconds },
    });
    logEvent("warn", "worker.job_retry", requestId, {
      job_id: job.id,
      document_id: job.document_id,
      user_id: job.user_id,
      error_code: code,
      attempt: job.attempt_count,
      retry_in_s: retry.delaySeconds,
    });
    return;
  }

  await db
    .from("ingestion_jobs")
    .update({
      status: "failed",
      completed_at: new Date(now).toISOString(),
      locked_at: null,
      locked_by: null,
      error_code: code,
      error_message: message.slice(0, 500),
    })
    .eq("id", job.id);

  await db
    .from("documents")
    .update({
      status: "failed",
      phase: "failed",
      failure_code: code,
      failure_message: message.slice(0, 500),
      error_message: message.slice(0, 500),
      completed_at: new Date(now).toISOString(),
    })
    .eq("id", job.document_id)
    .eq("user_id", job.user_id)
    .neq("status", "deleting");

  emitAsync({
    event: EVENTS.INGESTION_FAILED,
    requestId,
    status: "error",
    errorCode: code,
    userId: job.user_id,
    documentId: job.document_id,
    attributes: { job_id: job.id, attempts: job.attempt_count },
  });
  logEvent("error", "worker.job_failed", requestId, {
    job_id: job.id,
    document_id: job.document_id,
    user_id: job.user_id,
    error_code: code,
    attempts: job.attempt_count,
  });
}

async function cancelJob(db: Admin, job: Job, reason: string): Promise<void> {
  await db
    .from("ingestion_jobs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      error_code: "CANCELLED",
      error_message: reason,
    })
    .eq("id", job.id);
}

export type DrainResult = {
  claimed: number;
  succeeded: number;
  failed: number;
  retrying: number;
  cancelled: number;
};

/**
 * Claims up to `maxJobs` due jobs and runs them to completion. Safe to call
 * concurrently: claiming is an atomic SKIP LOCKED update, and jobs whose worker
 * died are reclaimed once their lock expires.
 */
export async function drainIngestionJobs(options: {
  maxJobs?: number;
  userId?: string;
  requestId?: string;
}): Promise<DrainResult> {
  const requestId = options.requestId ?? newRequestId();
  const db = await admin();
  const result: DrainResult = { claimed: 0, succeeded: 0, failed: 0, retrying: 0, cancelled: 0 };

  const { data: jobs, error } = await db.rpc("claim_ingestion_jobs", {
    worker_id: `${WORKER_VERSION}:${requestId}`,
    worker_version: WORKER_VERSION,
    max_jobs: Math.max(1, Math.min(options.maxJobs ?? 1, 5)),
    lock_seconds: LOCK_SECONDS,
    ...(options.userId ? { only_user_id: options.userId } : {}),
  });

  if (error) {
    logEvent("error", "worker.claim_failed", requestId, { detail: error.code });
    return result;
  }

  for (const job of (jobs ?? []) as Job[]) {
    result.claimed += 1;
    try {
      await processJob(db, job, requestId);
      await finishJob(db, job);
      result.succeeded += 1;
    } catch (error) {
      if (error instanceof JobCancelled) {
        await cancelJob(db, job, error.message);
        result.cancelled += 1;
        continue;
      }
      const failure = classifyError(error);
      const retry = isRetryable(failure, job.attempt_count)
        ? { delaySeconds: backoffSeconds(job.attempt_count, failure.failureClass) }
        : null;
      await failJob(db, job, failure.code, failure.message, retry, requestId);
      if (retry) {
        result.retrying += 1;
        await setPhase(db, job, "queued");
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}
