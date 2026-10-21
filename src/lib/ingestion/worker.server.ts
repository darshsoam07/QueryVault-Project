import { UploadQueue } from "@/lib/upload-queue";
import { INGESTION_LEASE_SECONDS } from "./lease";
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
import { embedTexts, requireAiProvider, toVectorLiteral } from "@/lib/ai-gateway.server";
import { logEvent, newRequestId } from "@/lib/api-errors";
import { EVENTS } from "@/lib/observability/events";
import { emitAsync } from "@/lib/observability/telemetry.server";
import { batchArray, preparePageChunks } from "@/lib/chunking";
import {
  MAX_UPLOAD_BYTES,
  MIN_UPLOAD_BYTES,
  isSupportedDocument,
  ownerScopedPath,
  sha256Hex,
} from "@/lib/documents.policy";
import { extractDocumentPages } from "./document-parser.server";
import {
  CHUNKER_VERSION,
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  EMBED_BATCH,
  OCR_SUSPECT_CHARS_PER_PAGE,
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
import { enforceRateLimit, pruneExpiredRateLimits } from "@/lib/rate-limit.server";
import { withDeadline, withRequestSignal } from "@/lib/async-deadline";
import { workerStage, WORKER_DEADLINES, safeWorkerCode } from "./stage.server";

type Admin = SupabaseClient<Database>;
type Job = Database["public"]["Tables"]["ingestion_jobs"]["Row"];

const LOCK_SECONDS = INGESTION_LEASE_SECONDS;

class JobCancelled extends Error {
  readonly code = "CLAIM_LOST";
}

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as Admin;
}

async function mutateClaim(
  db: Admin,
  job: Job,
  patch: Partial<Database["public"]["Tables"]["documents"]["Update"]> = {},
  chunks: unknown[] = [],
  jobPatch: Record<string, unknown> = {},
  prune?: number,
): Promise<void> {
  const stage =
    patch.status === "ready"
      ? "publish_ready"
      : chunks.length
        ? "vector_write"
        : jobPatch["status"] === "failed"
          ? "record_failure"
          : jobPatch["status"] === "retrying"
            ? "record_retry"
            : patch.phase
              ? `phase_write.${patch.phase}`
              : "claim_write";
  const { data, error } = await workerStage(job, stage, WORKER_DEADLINES.database, (signal) =>
    withRequestSignal(
      db.rpc("mutate_ingestion_claim", {
        job_id: job.id,
        claim_worker: job.locked_by!,
        claim_attempt: job.attempt_count,
        document_patch: JSON.parse(JSON.stringify(patch)),
        chunk_rows: JSON.parse(JSON.stringify(chunks)),
        job_patch: JSON.parse(JSON.stringify(jobPatch)),
        ...(prune !== undefined ? { prune_max_index: prune } : {}),
      }),
      signal,
    ),
  );
  if (error && ["PGRST202", "42883", "42703"].includes(error.code))
    throw permanent(
      "RPC_SCHEMA_MISMATCH",
      "Ingestion database schema is incompatible. An operator must verify the migrations before retrying.",
    );
  if (error)
    throw dependency("CLAIM_WRITE_FAILED", "Storing ingestion state failed. Retrying shortly.");
  if (!data) {
    // false also covers rejected metadata/payloads, not just removed claims.
    // Read errors remain failures; only an actually missing/replaced claim or
    // document is cancellation. The failure write remains fenced by the RPC.
    await assertLive(db, job);
    throw dependency(
      "CLAIM_WRITE_REJECTED",
      "The fenced ingestion write was rejected. Verify lease and database metadata compatibility.",
    );
  }
}
async function setPhase(
  db: Admin,
  job: Job,
  phase: IngestionPhase,
  patch: Partial<Database["public"]["Tables"]["documents"]["Update"]> = {},
): Promise<void> {
  await mutateClaim(db, job, { phase, ...patch });
}

/** Moves `documents.status` along the legal path towards `target`. */
async function advanceStatus(db: Admin, job: Job, target: "processing"): Promise<void> {
  const { data: doc, error } = await workerStage(
    job,
    "status_read",
    WORKER_DEADLINES.database,
    (signal) =>
      withRequestSignal(
        db
          .from("documents")
          .select("status")
          .eq("id", job.document_id)
          .eq("user_id", job.user_id)
          .maybeSingle(),
        signal,
      ),
  );
  if (error)
    throw dependency("DOCUMENT_READ_FAILED", "Could not read document state. Retrying shortly.");
  if (!doc) throw new JobCancelled("document removed");
  if (doc.status === "deleting") throw new JobCancelled("document is being deleted");

  const path: string[] = [];
  if (doc.status === "uploaded" || doc.status === "failed") path.push("validating", "stored");
  else if (doc.status === "validating") path.push("stored");
  path.push(target);

  for (const status of path) {
    if (status === doc.status) continue;
    await mutateClaim(db, job, { status });
  }
}

/** Throws if the document disappeared or entered deletion mid-run. */
async function assertLive(db: Admin, job: Job): Promise<void> {
  const { data: claim, error: claimError } = await workerStage(
    job,
    "claim_read",
    WORKER_DEADLINES.database,
    (signal) =>
      withRequestSignal(
        db
          .from("ingestion_jobs")
          .select("id")
          .eq("id", job.id)
          .eq("status", "running")
          .eq("locked_by", job.locked_by!)
          .eq("attempt_count", job.attempt_count)
          .maybeSingle(),
        signal,
      ),
  );
  if (claimError)
    throw dependency(
      "CLAIM_READ_FAILED",
      "Could not verify ingestion ownership. Retrying shortly.",
    );
  if (!claim) throw new JobCancelled("claim expired or replaced");
  const { data, error } = await workerStage(
    job,
    "document_live_read",
    WORKER_DEADLINES.database,
    (signal) =>
      withRequestSignal(
        db
          .from("documents")
          .select("status")
          .eq("id", job.document_id)
          .eq("user_id", job.user_id)
          .maybeSingle(),
        signal,
      ),
  );
  if (error)
    throw dependency("DOCUMENT_READ_FAILED", "Could not read document state. Retrying shortly.");
  if (!data) throw new JobCancelled("document removed");
  if (data.status === "deleting") throw new JobCancelled("document is being deleted");
}

/* ------------------------------ the pipeline ------------------------------ */

async function processJob(db: Admin, job: Job, requestId: string): Promise<{ chunks: number }> {
  let document: {
    filename: string;
    storage_path: string | null;
    content_type?: string | null;
    byte_size: number;
    content_hash: string | null;
  } | null = null;
  const primaryDoc = await workerStage(job, "document_read", WORKER_DEADLINES.database, (signal) =>
    withRequestSignal(
      db
        .from("documents")
        .select("filename, storage_path, content_type, byte_size, content_hash")
        .eq("id", job.document_id)
        .eq("user_id", job.user_id)
        .maybeSingle(),
      signal,
    ),
  );

  if (primaryDoc.data) {
    document = primaryDoc.data;
  } else if (
    primaryDoc.error &&
    (primaryDoc.error.code === "42703" ||
      primaryDoc.error.code === "PGRST204" ||
      (typeof primaryDoc.error.message === "string" &&
        primaryDoc.error.message.includes("content_type")))
  ) {
    const fallback = await workerStage(
      job,
      "document_read.compatibility",
      WORKER_DEADLINES.database,
      (signal) =>
        withRequestSignal(
          db
            .from("documents")
            .select("filename, storage_path, byte_size, content_hash")
            .eq("id", job.document_id)
            .eq("user_id", job.user_id)
            .maybeSingle(),
          signal,
        ),
    );
    if (fallback.error)
      throw dependency(
        "DOCUMENT_READ_FAILED",
        "Could not read the reserved document. Retrying shortly.",
      );
    document = fallback.data ? { ...fallback.data, content_type: null } : null;
  } else if (primaryDoc.error)
    throw dependency(
      "DOCUMENT_READ_FAILED",
      "Could not read the reserved document. Retrying shortly.",
    );

  if (!document) throw new JobCancelled("document removed");
  const storagePath =
    document.storage_path ?? ownerScopedPath(job.user_id, job.document_id, document.filename);
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

  const { data: blob, error: downloadError } = await workerStage(
    job,
    "storage_download",
    WORKER_DEADLINES.storage,
    (signal) => db.storage.from("documents").download(storagePath, {}, { signal }),
  );
  if (downloadError || !blob) {
    const code = downloadError
      ? String(downloadError.status ?? downloadError.statusCode ?? "")
      : "";
    const storageCode = downloadError && "code" in downloadError ? downloadError.code : undefined;
    if (code === "404" || storageCode === "NoSuchKey" || (!downloadError && !blob))
      throw permanent("MISSING_OBJECT", "The uploaded file is missing. Upload it again.");
    if (code === "401" || code === "403")
      throw permanent(
        "STORAGE_FORBIDDEN",
        "Storage access was denied. An operator must verify the configuration.",
      );
    throw dependency(
      "STORAGE_UNAVAILABLE",
      "Storage could not return the uploaded file. Retrying shortly.",
    );
  }
  if (blob.size < MIN_UPLOAD_BYTES) throw permanent("EMPTY_FILE", "That file is empty.");
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw permanent(
      "TOO_LARGE",
      `Files must be smaller than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    );
  }
  if (!isSupportedDocument(document.filename, document.content_type)) {
    throw permanent("BAD_CONTENT_TYPE", "This file type is not allowed.");
  }
  if (blob.size !== document.byte_size)
    throw permanent(
      "SIZE_MISMATCH",
      "The stored file size differs from the reserved upload. Remove it and upload again.",
    );
  const bytes = new Uint8Array(
    await workerStage(job, "storage_body", WORKER_DEADLINES.local, () => blob.arrayBuffer()),
  );
  if (
    document.content_hash &&
    (await workerStage(job, "hash_validation", WORKER_DEADLINES.local, () => sha256Hex(bytes))) !==
      document.content_hash
  )
    throw permanent(
      "HASH_MISMATCH",
      "The stored file differs from the reserved upload. Remove it and upload again.",
    );

  const queueWaitMs = job.created_at
    ? Math.max(0, Date.now() - new Date(job.created_at).getTime())
    : null;

  await mutateClaim(db, job, { storage_path: storagePath, byte_size: blob.size });

  // ---- parse -----------------------------------------------------------
  await assertLive(db, job);
  await setPhase(db, job, "parsing", { progress: 25 });
  const parseStart = Date.now();
  const pages = await workerStage(job, "parse", WORKER_DEADLINES.parser, () =>
    extractDocumentPages(bytes, document.filename),
  );
  const parseDurationMs = Date.now() - parseStart;
  const textLength = pages.reduce((sum, page) => sum + page.text.trim().length, 0);
  if (textLength < 40) {
    throw permanent(
      "NO_TEXT_LAYER",
      "No readable text found. Scanned PDFs and images need OCR before upload.",
    );
  }

  // Phase 3: OCR-suspect detection — flag scan-only PDFs so the UI can warn.
  // The documents table has no metadata column, so we record the warning in
  // error_message (informational, does not set status to failed) and log it.
  const pageCount = pages.length || 1;
  if (textLength / pageCount < OCR_SUSPECT_CHARS_PER_PAGE && textLength < 500) {
    await mutateClaim(db, job, {
      error_message: "OCR suspect: very little text per page; may be a scanned PDF",
    });
    logEvent("warn", "worker.ocr_suspect", requestId, {
      document_id: job.document_id,
      chars_per_page: Math.round(textLength / pageCount),
    });
  }

  // ---- chunk -----------------------------------------------------------
  await advanceStatus(db, job, "processing");
  await setPhase(db, job, "chunking", { progress: 40, page_count: pages.length });
  const chunkStart = Date.now();
  const chunks = await workerStage(job, "chunk", WORKER_DEADLINES.local, () =>
    preparePageChunks(pages, CHUNK_SIZE, CHUNK_OVERLAP),
  );
  const chunkDurationMs = Date.now() - chunkStart;
  if (chunks.length === 0) {
    throw permanent("NO_CHUNKS", "This document produced no usable text.");
  }

  // ---- embed + index ---------------------------------------------------
  const provider = await workerStage(job, "provider_configuration", WORKER_DEADLINES.local, () =>
    requireAiProvider(),
  );
  const batches = batchArray(chunks, EMBED_BATCH);
  let indexed = 0;
  let totalEmbedDurationMs = 0;
  let totalUpsertDurationMs = 0;

  for (const batch of batches) {
    await assertLive(db, job);
    await setPhase(db, job, "embedding", {
      progress: 40 + Math.round((indexed / chunks.length) * 45),
    });

    let embeddings: number[][];
    const embedStart = Date.now();
    try {
      await workerStage(job, "embedding_admission", WORKER_DEADLINES.database, () =>
        enforceRateLimit(job.user_id, "embed"),
      );
      embeddings = await workerStage(job, "embedding", WORKER_DEADLINES.embedding, (signal) =>
        embedTexts(
          batch.map((chunk) => chunk.content),
          provider,
          { signal },
        ),
      );
    } catch (error) {
      throw classifyError(error);
    }
    totalEmbedDurationMs += Date.now() - embedStart;

    await setPhase(db, job, "indexing");
    const rows = await workerStage(job, "vector_prepare", WORKER_DEADLINES.local, () =>
      Promise.all(
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
      ),
    );

    // Deterministic ids + upsert = a retried batch overwrites, never duplicates.
    const upsertStart = Date.now();
    await mutateClaim(db, job, {}, rows);
    totalUpsertDurationMs += Date.now() - upsertStart;

    indexed += rows.length;
    await mutateClaim(db, job, { chunk_count: indexed });
  }

  // ---- finalise --------------------------------------------------------
  await assertLive(db, job);
  await setPhase(db, job, "indexing", { progress: 95 });
  // Anything from an older pipeline version or a longer previous run must go
  // before the document can be trusted as READY.
  await mutateClaim(
    db,
    job,
    {
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
    },
    [],
    {
      status: "succeeded",
      completed_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      error_code: null,
      error_message: null,
    },
    chunks.length - 1,
  );

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
      queue_wait_ms: queueWaitMs,
      parse_duration_ms: parseDurationMs,
      chunk_duration_ms: chunkDurationMs,
      embed_duration_ms: totalEmbedDurationMs,
      upsert_duration_ms: totalUpsertDurationMs,
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
    await mutateClaim(db, job, { phase: "queued" }, [], {
      status: "retrying",
      available_at: new Date(now + retry.delaySeconds * 1000).toISOString(),
      locked_at: null,
      locked_by: null,
      error_code: code,
      error_message: message.slice(0, 500),
    });
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

  await mutateClaim(
    db,
    job,
    {
      status: "failed",
      phase: "failed",
      failure_code: code,
      failure_message: message.slice(0, 500),
      error_message: message.slice(0, 500),
      completed_at: new Date(now).toISOString(),
    },
    [],
    {
      status: "failed",
      completed_at: new Date(now).toISOString(),
      locked_at: null,
      locked_by: null,
      error_code: code,
      error_message: message.slice(0, 500),
    },
  );

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

export type DrainResult = {
  claimed: number;
  succeeded: number;
  failed: number;
  retrying: number;
  cancelled: number;
  unconfirmed: number;
};

/**
 * Claims up to `maxJobs` due jobs and runs them to completion. Safe to call
 * concurrently: claiming is an atomic SKIP LOCKED update, and jobs whose worker
 * died are reclaimed once their lock expires.
 */
const drainSlots = new UploadQueue(1);
export function drainIngestionJobs(options: {
  maxJobs?: number;
  userId?: string;
  requestId?: string;
}): Promise<DrainResult> {
  const requestId = options.requestId ?? newRequestId();
  const waitingSince = performance.now();
  logEvent("info", "worker.drain_requested", requestId, {});
  // Never release this slot by racing an uncancelled pipeline against a timer.
  // Stage deadlines settle the pipeline before the next drain can claim work.
  return drainSlots.run(() => {
    logEvent("info", "worker.drain_started", requestId, {
      wait_ms: Math.round(performance.now() - waitingSince),
    });
    return drainClaimedJobs({ ...options, requestId });
  });
}
async function drainClaimedJobs(options: {
  maxJobs?: number;
  userId?: string;
  requestId?: string;
}): Promise<DrainResult> {
  const requestId = options.requestId ?? newRequestId();
  const db = await admin();
  const result: DrainResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    retrying: 0,
    cancelled: 0,
    unconfirmed: 0,
  };

  const defaultConcurrency = 3;
  const envConcurrency =
    typeof process !== "undefined" && process.env["INGESTION_WORKER_CONCURRENCY"]
      ? parseInt(process.env["INGESTION_WORKER_CONCURRENCY"], 10)
      : defaultConcurrency;
  const concurrency = Math.max(
    1,
    Math.min(Number.isFinite(envConcurrency) ? envConcurrency : defaultConcurrency, 5),
  );

  let claimResult;
  try {
    claimResult = await withDeadline(
      (signal) =>
        withRequestSignal(
          db.rpc("claim_ingestion_jobs", {
            worker_id: `${WORKER_VERSION}:${requestId}`,
            worker_version: WORKER_VERSION,
            max_jobs: Math.max(1, Math.min(options.maxJobs ?? concurrency, concurrency)),
            lock_seconds: LOCK_SECONDS,
            ...(options.userId ? { only_user_id: options.userId } : {}),
          }),
          signal,
        ),
      WORKER_DEADLINES.database,
    );
  } catch (error) {
    logEvent("error", "worker.claim_failed", requestId, {
      stage: "claim_jobs",
      error_code:
        error instanceof Error && error.name === "TimeoutError"
          ? "STAGE_TIMEOUT"
          : safeWorkerCode(error),
    });
    return result;
  }
  const { data: jobs, error } = claimResult;

  if (error) {
    logEvent("error", "worker.claim_failed", requestId, { detail: error.code });
    return result;
  }

  const claimedJobs = (jobs ?? []) as Job[];
  result.claimed = claimedJobs.length;
  for (const job of claimedJobs) {
    logEvent("info", "worker.claimed", requestId, {
      job_id: job.id,
      attempt: job.attempt_count,
      subsequent_attempt: job.attempt_count > 1,
    });
  }

  if (claimedJobs.length > 0) {
    // Process claimed jobs with bounded concurrency
    await Promise.all(
      claimedJobs.map(async (job) => {
        let heartbeatPending = false;
        const heartbeat = setInterval(() => {
          if (heartbeatPending) return;
          heartbeatPending = true;
          void workerStage(job, "lease_renewal", WORKER_DEADLINES.database, (signal) =>
            withRequestSignal(
              db.rpc("mutate_ingestion_claim", {
                job_id: job.id,
                claim_worker: job.locked_by!,
                claim_attempt: job.attempt_count,
                job_patch: { locked_at: new Date().toISOString() },
              }),
              signal,
            ),
          )
            .then(({ data, error }) => {
              if (error || !data) {
                clearInterval(heartbeat);
                logEvent("warn", "worker.lease_renewal_rejected", requestId, {
                  job_id: job.id,
                  attempt: job.attempt_count,
                  error_code: error ? "LEASE_RENEWAL_FAILED" : "CLAIM_LOST",
                });
              } else {
                logEvent("info", "worker.lease_renewed", requestId, {
                  job_id: job.id,
                  attempt: job.attempt_count,
                });
              }
            })
            .catch((error) => {
              clearInterval(heartbeat);
              logEvent("warn", "worker.lease_renewal_failed", requestId, {
                job_id: job.id,
                attempt: job.attempt_count,
                error_code: safeWorkerCode(error),
              });
            })
            .finally(() => {
              heartbeatPending = false;
            });
        }, 30_000);
        try {
          await processJob(db, job, requestId);
          result.succeeded += 1;
        } catch (error) {
          if (error instanceof JobCancelled) {
            result.cancelled += 1;
            logEvent("info", "worker.job_cancelled", requestId, {
              job_id: job.id,
              error_code: error.code,
            });
            return;
          }
          const failure = classifyError(error);
          const retry =
            isRetryable(failure, job.attempt_count) && job.attempt_count < (job.max_attempts ?? 4)
              ? { delaySeconds: backoffSeconds(job.attempt_count, failure.failureClass) }
              : null;
          try {
            // The mutation RPC itself checks the live lease atomically. A
            // separate failed read must not silently erase the real failure.
            await failJob(db, job, failure.code, failure.message, retry, requestId);
            if (retry) result.retrying += 1;
            else result.failed += 1;
          } catch (persistError) {
            if (persistError instanceof JobCancelled) result.cancelled += 1;
            else {
              result.unconfirmed += 1;
              logEvent("error", "worker.failure_recording_deferred", requestId, {
                job_id: job.id,
                attempt: job.attempt_count,
                error_code: safeWorkerCode(persistError),
                original_error_code: failure.code,
              });
            }
          }
        } finally {
          clearInterval(heartbeat);
        }
      }),
    );
  }

  // Phase 5+6: prune stale rate-limit counters at end of every drain cycle.
  try {
    await withDeadline(() => pruneExpiredRateLimits(), WORKER_DEADLINES.database);
  } catch {
    logEvent("warn", "worker.maintenance_failed", requestId, {
      error_code: "RATE_LIMIT_PRUNE_FAILED",
    });
  }

  let queueDepth: number | null = null;
  try {
    const snapshot = await withDeadline(
      (signal) =>
        withRequestSignal(
          db
            .from("ingestion_jobs")
            .select("id", { count: "exact", head: true })
            .in("status", ["queued", "retrying"]),
          signal,
        ),
      WORKER_DEADLINES.database,
    );
    if (!snapshot.error) queueDepth = snapshot.count;
  } catch {
    logEvent("warn", "worker.queue_depth_unavailable", requestId, {
      error_code: "QUEUE_READ_FAILED",
    });
  }

  logEvent("info", "worker.drain_cycle_completed", requestId, {
    concurrency,
    claimed: result.claimed,
    succeeded: result.succeeded,
    failed: result.failed,
    retrying: result.retrying,
    cancelled: result.cancelled,
    unconfirmed: result.unconfirmed,
    queue_depth: queueDepth,
  });

  return result;
}
