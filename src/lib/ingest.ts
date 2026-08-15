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
  hasPdfMagicBytes,
  sha256Hex,
} from "@/lib/documents.policy";
import {
  createDocumentUpload,
  enqueueIngestion,
  getIngestionStatus,
  runIngestionWorker,
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
};

function toStatus(
  documentId: string,
  jobId: string | null,
  phase: IngestionPhase,
  detail: string,
  reason: string | null = null,
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
  };
}

const isPhase = (value: string): value is IngestionPhase => value in PHASE_LABELS;

export type UploadHandle = { documentId: string; jobId: string };

/** Upload + enqueue. Returns as soon as the job is queued. */
export async function uploadAndEnqueue(
  file: File,
  onStatus: (status: IngestStatus) => void,
): Promise<UploadHandle> {
  if (file.size < MIN_UPLOAD_BYTES) throw new Error("That PDF is empty.");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `PDFs must be smaller than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    );
  }

  const buffer = await file.arrayBuffer();
  if (!hasPdfMagicBytes(new Uint8Array(buffer))) throw new Error("That file is not a valid PDF.");
  const contentHash = await sha256Hex(buffer);

  const { documentId, storagePath } = await createDocumentUpload({
    data: {
      filename: file.name,
      byteSize: file.size,
      contentType: file.type || "application/pdf",
      contentHash,
    },
  });

  onStatus(toStatus(documentId, null, "uploading", "Uploading the original file…"));
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, file, { contentType: "application/pdf", upsert: true });
  if (uploadError) throw new Error(uploadError.message);

  const { jobId } = await enqueueIngestion({ data: { documentId } });
  onStatus(toStatus(documentId, jobId, "queued", "Queued for server-side indexing…"));

  // Kick the worker; if this request dies the job is still durable and gets
  // picked up by the next drain.
  void runIngestionWorker({ data: { maxJobs: 1 } }).catch(() => undefined);

  return { documentId, jobId };
}

/** Polls real server phases until the document is ready or failed. */
export async function pollIngestion(
  handle: UploadHandle,
  onStatus: (status: IngestStatus) => void,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<IngestStatus> {
  const intervalMs = options.intervalMs ?? 1500;
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000);
  let kicks = 0;

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
      ),
    );

    if (Date.now() > deadline) {
      return toStatus(
        handle.documentId,
        job?.id ?? handle.jobId,
        "failed",
        "Indexing is taking longer than expected. It will continue in the background.",
      );
    }

    // Nudge the worker if the job is still waiting (serverless has no daemon).
    if ((job?.status === "queued" || job?.status === "retrying") && kicks < 40) {
      kicks += 1;
      void runIngestionWorker({ data: { maxJobs: 1 } }).catch(() => undefined);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
