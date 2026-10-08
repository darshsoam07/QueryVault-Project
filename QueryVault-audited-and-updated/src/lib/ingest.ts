/**
 * Thin client. The browser only: hashes the file, uploads the original to
 * protected storage, enqueues a durable job, kicks the worker and polls status.
 *
 * No parsing, chunking, embedding or indexing happens here.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  MAX_UPLOAD_BYTES,
  MIN_UPLOAD_BYTES,
  isSupportedDocument,
  sha256Hex,
} from "@/lib/documents.policy";
import {
  createDocumentUpload,
  enqueueIngestion,
  getIngestionStatus,
} from "@/lib/documents.functions";
import { PHASE_LABELS, phaseProgress, type IngestionPhase } from "@/lib/ingestion/contract";

export type IngestStatus = {
  documentId: string;
  jobId: string | null;
  phase: IngestionPhase;
  label: string;
  step: number;
  totalSteps: number;
  detail: string;
  failed: boolean;
  reason: string | null;
  uploadDurationMs?: number;
};

function toStatus(
  documentId: string,
  jobId: string | null,
  phase: IngestionPhase,
  detail: string,
  reason: string | null = null,
  uploadDurationMs?: number,
): IngestStatus {
  const { step, total } = phaseProgress(phase);
  return {
    documentId,
    jobId,
    phase,
    label: PHASE_LABELS[phase],
    step,
    totalSteps: total,
    detail,
    failed: phase === "failed",
    reason,
    ...(uploadDurationMs !== undefined ? { uploadDurationMs } : {}),
  };
}

const isPhase = (value: string): value is IngestionPhase => value in PHASE_LABELS;

export type UploadHandle = { documentId: string; jobId: string; uploadDurationMs?: number };

/** Upload + enqueue. Returns as soon as the job is queued without executing worker tasks. */
export async function uploadAndEnqueue(
  file: File,
  onStatus: (status: IngestStatus) => void,
): Promise<UploadHandle> {
  if (!isSupportedDocument(file.name, file.type))
    throw new Error("This file type is not supported.");
  if (file.size < MIN_UPLOAD_BYTES) throw new Error("That file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Files must be smaller than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    );
  }

  // Calculate sha256 in a scoped block so the buffer is immediately eligible for GC
  let contentHash: string;
  {
    const sliceBuffer = await file.arrayBuffer();
    contentHash = await sha256Hex(sliceBuffer);
  }

  const { documentId, storagePath } = await createDocumentUpload({
    data: {
      filename: file.name,
      byteSize: file.size,
      contentType: file.type || "application/octet-stream",
      contentHash,
    },
  });

  onStatus(toStatus(documentId, null, "uploading", "Uploading the original file…"));
  const uploadStart = Date.now();
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, file, {
      contentType: file.type || "application/octet-stream",
      upsert: true,
    });
  if (uploadError) throw new Error(uploadError.message);
  const uploadDurationMs = Date.now() - uploadStart;

  const { jobId } = await enqueueIngestion({ data: { documentId } });
  onStatus(toStatus(documentId, jobId, "queued", "Queued for server-side indexing…", null, uploadDurationMs));

  return { documentId, jobId, uploadDurationMs };
}

/** Polls real server phases until the document is ready or failed. Never runs worker jobs. */
export async function pollIngestion(
  handle: UploadHandle,
  onStatus: (status: IngestStatus) => void,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<IngestStatus> {
  const intervalMs = options.intervalMs ?? 1500;
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000);

  for (;;) {
    let snapshot: Awaited<ReturnType<typeof getIngestionStatus>>;
    try {
      snapshot = await getIngestionStatus({ data: { documentId: handle.documentId } });
    } catch {
      return toStatus(handle.documentId, handle.jobId, "failed", "Lost track of this document.");
    }

    const { document, job } = snapshot;
    const phase: IngestionPhase = isPhase(document.phase) ? document.phase : "queued";
    const reason = document.failure_message ?? job?.error_message ?? null;

    if (document.status === "ready") {
      const status = toStatus(
        handle.documentId,
        job?.id ?? handle.jobId,
        "ready",
        `${document.chunk_count} chunks indexed`,
        null,
        handle.uploadDurationMs,
      );
      onStatus(status);
      return status;
    }

    if (document.status === "failed" || job?.status === "failed") {
      const status = toStatus(
        handle.documentId,
        job?.id ?? handle.jobId,
        "failed",
        reason ?? "Ingestion failed.",
        reason,
        handle.uploadDurationMs,
      );
      onStatus(status);
      return status;
    }

    onStatus(
      toStatus(
        handle.documentId,
        job?.id ?? handle.jobId,
        phase,
        job?.status === "retrying"
          ? `Retrying after a transient failure (attempt ${job.attempt_count})…`
          : `${PHASE_LABELS[phase]}…`,
        reason,
        handle.uploadDurationMs,
      ),
    );

    if (Date.now() > deadline) {
      return toStatus(
        handle.documentId,
        job?.id ?? handle.jobId,
        "failed",
        "Indexing is taking longer than expected. It will continue in the background.",
        null,
        handle.uploadDurationMs,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

