/**
 * Client-callable document API. Thin wrappers only — the browser can create a
 * document, upload the original file, enqueue/kick a job and read status. It
 * can never submit chunks, embeddings or a READY signal.
 */
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ApiError, logEvent, newRequestId } from "@/lib/api-errors";
import {
  ACTIVE_STATES,
  MAX_UPLOAD_BYTES,
  MIN_UPLOAD_BYTES,
  isAllowedContentType,
  isSha256,
  ownerScopedPath,
  safeFilename,
} from "@/lib/documents.policy";
import { PARSER_VERSION } from "@/lib/ingestion/contract";
import { MAX_CONCURRENT_INGESTIONS } from "@/lib/rate-limits";
import { EVENTS } from "@/lib/observability/events";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const uuid = z.string().uuid();

/* -------------------------------------------------------------------------- */
/* 1. Reserve a document (server-authoritative metadata + duplicate detection) */
/* -------------------------------------------------------------------------- */

const CreateInput = z.object({
  filename: z.string().min(1).max(300),
  byteSize: z.number().int().min(MIN_UPLOAD_BYTES).max(MAX_UPLOAD_BYTES),
  contentType: z.string().max(200).nullish(),
  contentHash: z.string().refine(isSha256, "content hash must be a SHA-256 hex digest"),
});

export const createDocumentUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CreateInput.parse(input))
  .handler(async ({ data, context }) => {
    const { enforceRateLimit, RateLimitError } = await import("@/lib/rate-limit.server");
    const { emitAsync } = await import("@/lib/observability/telemetry.server");
    const requestId = newRequestId();
    const startedAt = Date.now();
    const { supabase, userId } = context;

    if (data.contentType && !isAllowedContentType(data.contentType)) {
      emitAsync({
        event: EVENTS.DOCUMENT_VALIDATION_FAILED,
        requestId,
        status: "error",
        errorCode: "DOCUMENT_INVALID",
        userId,
        attributes: { reason: "content_type", byte_size: data.byteSize },
      });
      throw new ApiError("DOCUMENT_INVALID", "Only PDF files can be uploaded.");
    }

    try {
      await enforceRateLimit(userId, "upload");
    } catch (error) {
      if (error instanceof RateLimitError) {
        emitAsync({
          event: EVENTS.QUOTA_EXCEEDED,
          requestId,
          status: "error",
          errorCode: "RATE_LIMITED",
          userId,
          attributes: { bucket: "upload", retry_after_s: error.retryAfter },
        });
      }
      throw error;
    }

    const { count: activeCount } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("status", [...ACTIVE_STATES]);

    if ((activeCount ?? 0) >= MAX_CONCURRENT_INGESTIONS) {
      emitAsync({
        event: EVENTS.QUOTA_EXCEEDED,
        requestId,
        status: "error",
        errorCode: "RATE_LIMITED",
        userId,
        attributes: { bucket: "concurrent_ingestions", active: activeCount ?? 0 },
      });
      throw new ApiError(
        "RATE_LIMITED",
        `You already have ${MAX_CONCURRENT_INGESTIONS} documents indexing. Wait for those to finish.`,
      );
    }

    const { data: duplicate } = await supabase
      .from("documents")
      .select("id, filename")
      .eq("user_id", userId)
      .eq("content_hash", data.contentHash)
      .maybeSingle();

    if (duplicate) {
      emitAsync({
        event: EVENTS.DOCUMENT_VALIDATION_FAILED,
        requestId,
        status: "error",
        errorCode: "DOCUMENT_DUPLICATE",
        userId,
        documentId: duplicate.id,
        attributes: { reason: "duplicate_hash" },
      });
      throw new ApiError(
        "DOCUMENT_DUPLICATE",
        `This file is already in your vault as "${duplicate.filename}".`,
      );
    }

    const filename = safeFilename(data.filename);
    // Pipeline-owned table: the browser has no INSERT/UPDATE grant on `documents`.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: doc, error } = await supabaseAdmin
      .from("documents")
      .insert({
        user_id: userId,
        filename,
        byte_size: data.byteSize,
        status: "uploaded",
        phase: "uploading",
        progress: 0,
        content_hash: data.contentHash,
        parser_version: PARSER_VERSION,
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error || !doc) {
      if (error?.code === "23505") {
        throw new ApiError("DOCUMENT_DUPLICATE", "This file is already in your vault.");
      }
      logEvent("error", "ingest.create_failed", requestId, { user_id: userId });
      throw new ApiError("INTERNAL", "Could not create the document record.");
    }

    emitAsync({
      event: EVENTS.DOCUMENT_UPLOADED,
      requestId,
      status: "ok",
      userId,
      documentId: doc.id,
      latencyMs: Date.now() - startedAt,
      attributes: { byte_size: data.byteSize },
    });
    return {
      documentId: doc.id,
      filename,
      storagePath: ownerScopedPath(userId, doc.id),
      requestId,
    };
  });

/* -------------------------------------------------------------------------- */
/* 2. Enqueue a durable ingestion job                                          */
/* -------------------------------------------------------------------------- */

export const enqueueIngestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ documentId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const requestId = newRequestId();
    const { supabase, userId } = context;

    const { data: doc } = await supabase
      .from("documents")
      .select("id, status")
      .eq("id", data.documentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!doc) throw new ApiError("DOCUMENT_NOT_FOUND", "That document no longer exists.");
    if (doc.status === "deleting") {
      throw new ApiError("ILLEGAL_STATE_TRANSITION", "That document is being removed.");
    }

    const { data: live } = await supabase
      .from("ingestion_jobs")
      .select("id, status")
      .eq("document_id", data.documentId)
      .in("status", ["queued", "running", "retrying"])
      .maybeSingle();

    if (live) {
      return { documentId: data.documentId, jobId: live.id, status: "queued" as const, requestId };
    }

    const { data: job, error } = await supabase
      .from("ingestion_jobs")
      .insert({ document_id: data.documentId, user_id: userId, status: "queued", kind: "ingest" })
      .select("id")
      .single();
    if (error || !job) {
      logEvent("error", "ingest.enqueue_failed", requestId, { user_id: userId });
      throw new ApiError("INTERNAL", "Could not queue this document for indexing.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("documents")
      .update({ phase: "queued", progress: 5 })
      .eq("id", data.documentId)
      .eq("user_id", userId);

    logEvent("info", "ingest.queued", requestId, {
      user_id: userId,
      document_id: data.documentId,
      job_id: job.id,
    });
    return { documentId: data.documentId, jobId: job.id, status: "queued" as const, requestId };
  });

/* -------------------------------------------------------------------------- */
/* 3. Kick the worker for the caller's own jobs                                */
/* -------------------------------------------------------------------------- */

export const runIngestionWorker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ maxJobs: z.number().int().min(1).max(3).default(1) }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { drainIngestionJobs } = await import("@/lib/ingestion/worker.server");
    return drainIngestionJobs({ maxJobs: data.maxJobs, userId: context.userId });
  });

/* -------------------------------------------------------------------------- */
/* 4. Status for polling                                                       */
/* -------------------------------------------------------------------------- */

export const getIngestionStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ documentId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: doc } = await supabase
      .from("documents")
      .select("id, status, phase, progress, chunk_count, page_count, failure_code, failure_message")
      .eq("id", data.documentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!doc) throw new ApiError("DOCUMENT_NOT_FOUND", "That document no longer exists.");

    const { data: job } = await supabase
      .from("ingestion_jobs")
      .select("id, status, attempt_count, error_code, error_message, available_at")
      .eq("document_id", data.documentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return { document: doc, job: job ?? null };
  });

/* -------------------------------------------------------------------------- */
/* 5. Reindex — new job over the existing source file, never duplicate vectors */
/* -------------------------------------------------------------------------- */

export const reindexDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ documentId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const requestId = newRequestId();
    const { supabase, userId } = context;

    const { data: doc } = await supabase
      .from("documents")
      .select("id, status, storage_path")
      .eq("id", data.documentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!doc) throw new ApiError("DOCUMENT_NOT_FOUND", "That document no longer exists.");
    if (doc.status === "deleting") {
      throw new ApiError("ILLEGAL_STATE_TRANSITION", "That document is being removed.");
    }

    const path = doc.storage_path ?? ownerScopedPath(userId, data.documentId);
    const { data: found, error: listError } = await supabase.storage
      .from("documents")
      .list(userId, { search: `${data.documentId}.pdf`, limit: 1 });
    if (listError || !found || found.length === 0) {
      throw new ApiError(
        "DOCUMENT_NOT_FOUND",
        "The original file is no longer stored. Upload it again to reindex.",
      );
    }

    const { data: live } = await supabase
      .from("ingestion_jobs")
      .select("id")
      .eq("document_id", data.documentId)
      .in("status", ["queued", "running", "retrying"])
      .maybeSingle();
    if (live) {
      return { documentId: data.documentId, jobId: live.id, status: "queued" as const, requestId };
    }

    const { data: job, error } = await supabase
      .from("ingestion_jobs")
      .insert({ document_id: data.documentId, user_id: userId, status: "queued", kind: "reindex" })
      .select("id")
      .single();
    if (error || !job) throw new ApiError("INTERNAL", "Could not queue a reindex.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("documents")
      .update({
        phase: "queued",
        progress: 5,
        storage_path: path,
        failure_code: null,
        failure_message: null,
        error_message: null,
      })
      .eq("id", data.documentId)
      .eq("user_id", userId);

    logEvent("info", "ingest.reindex_queued", requestId, {
      user_id: userId,
      document_id: data.documentId,
      job_id: job.id,
    });
    return { documentId: data.documentId, jobId: job.id, status: "queued" as const, requestId };
  });

/* -------------------------------------------------------------------------- */
/* 6. Safe, retryable delete (cancels any in-flight job first)                 */
/* -------------------------------------------------------------------------- */

export const deleteDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ documentId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const requestId = newRequestId();
    const deleteStarted = Date.now();
    const { supabase, userId } = context;

    // 1. Authorize
    const { data: doc } = await supabase
      .from("documents")
      .select("id, status, storage_path")
      .eq("id", data.documentId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!doc) throw new ApiError("DOCUMENT_NOT_FOUND", "That document no longer exists.");

    // 2. Mark deleting — the worker checks this between every phase and aborts.
    //    Pipeline state is server-written; the browser has no UPDATE grant.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (doc.status !== "deleting") {
      const { error } = await supabaseAdmin
        .from("documents")
        .update({ status: "deleting", phase: "deleting", progress: 0 })
        .eq("id", data.documentId)
        .eq("user_id", userId);
      if (error) throw new ApiError("INTERNAL", "Could not start deleting that document.");
    }

    // 3. Cancel any live job so a running worker cannot resurrect the document.
    await supabaseAdmin
      .from("ingestion_jobs")
      .update({
        status: "failed",
        error_code: "CANCELLED",
        error_message: "Document deleted",
        completed_at: new Date().toISOString(),
        locked_at: null,
      })
      .eq("document_id", data.documentId)
      .in("status", ["queued", "running", "retrying"]);

    // 4. Chunks (worker-owned table)
    const { error: chunkError } = await supabaseAdmin
      .from("document_chunks")
      .delete()
      .eq("document_id", data.documentId)
      .eq("user_id", userId);
    if (chunkError) {
      logEvent("error", "delete.chunks_failed", requestId, {
        user_id: userId,
        document_id: data.documentId,
      });
      throw new ApiError("INTERNAL", "Deleting the index failed. Try again to finish removal.");
    }

    // 5. Storage object (never orphaned: the row stays in `deleting` on failure)
    const path = doc.storage_path ?? ownerScopedPath(userId, data.documentId);
    const { error: storageError } = await supabase.storage.from("documents").remove([path]);
    if (storageError) {
      logEvent("error", "delete.storage_failed", requestId, {
        user_id: userId,
        document_id: data.documentId,
      });
      throw new ApiError(
        "INTERNAL",
        "Deleting the stored file failed. Try again to finish removal.",
      );
    }

    // 6. Metadata (jobs cascade)
    const { error: rowError } = await supabase
      .from("documents")
      .delete()
      .eq("id", data.documentId)
      .eq("user_id", userId);
    if (rowError) throw new ApiError("INTERNAL", "Could not remove the document record.");

    const { emitAsync: emitDeleted } = await import("@/lib/observability/telemetry.server");
    emitDeleted({
      event: EVENTS.DOCUMENT_DELETED,
      requestId,
      status: "ok",
      userId,
      documentId: data.documentId,
      latencyMs: Date.now() - deleteStarted,
    });
    return { ok: true as const };
  });
