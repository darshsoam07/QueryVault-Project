import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, RefreshCw, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";

import EmptyState from "@/components/EmptyState";
import UploadZone from "@/components/UploadZone";
import { useDocuments } from "@/hooks/useHealth";
import { api } from "@/lib/api";
import { cn, formatBytes, formatDate } from "@/lib/utils";
import type { DocumentStatus } from "@/types";

const STATUS_LABEL: Record<DocumentStatus, string> = {
  uploading: "Uploading",
  parsing: "Parsing",
  chunking: "Chunking",
  embedding: "Generating embeddings",
  indexing: "Indexing",
  ready: "Ready",
  error: "Error",
};

export default function DocumentsPage() {
  const queryClient = useQueryClient();
  const { data: documents = [], isLoading, error } = useDocuments();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["documents"] });
    queryClient.invalidateQueries({ queryKey: ["stats"] });
  };

  const remove = useMutation({ mutationFn: api.deleteDocument, onSuccess: invalidate });
  const reindex = useMutation({ mutationFn: api.reindexDocument, onSuccess: invalidate });

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Document library</h1>
      <p className="mt-1 text-xs text-muted">
        Everything here is parsed, chunked and indexed by the backend pipeline.
      </p>

      <div className="mt-6">
        <UploadZone />
      </div>

      {error && (
        <p className="mt-6 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-300">
          {(error as Error).message}
        </p>
      )}

      <div className="mt-6 space-y-2">
        {!isLoading && !error && documents.length === 0 && (
          <EmptyState
            title="Your knowledge base is empty."
            description="Upload your first document to start asking questions."
          />
        )}

        {documents.map((doc) => (
          <div
            key={doc.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3"
          >
            <FileText size={16} className="text-amethyst" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{doc.filename}</p>
              <p className="font-mono text-[11px] text-muted">
                {formatBytes(doc.file_size)} · {formatDate(doc.upload_time)} ·{" "}
                {doc.chunk_count} chunks · {doc.page_count} pages
              </p>
              {doc.error_message && (
                <p className="mt-1 text-[11px] text-red-400">{doc.error_message}</p>
              )}
            </div>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                doc.status === "ready"
                  ? "border-emerald-500/30 text-emerald-300"
                  : doc.status === "error"
                    ? "border-red-500/30 text-red-300"
                    : "border-cyan/30 text-cyan",
              )}
            >
              {STATUS_LABEL[doc.status]}
            </span>
            <div className="flex items-center gap-1">
              <Link
                to="/chat"
                className="rounded-md border border-line px-2 py-1 text-[11px] text-muted hover:text-ink"
              >
                Ask
              </Link>
              <button
                className="rounded-md p-1.5 text-muted hover:text-ink"
                aria-label="Re-index"
                onClick={() => reindex.mutate(doc.id)}
              >
                <RefreshCw size={14} />
              </button>
              <button
                className="rounded-md p-1.5 text-muted hover:text-red-400"
                aria-label="Delete"
                onClick={() => remove.mutate(doc.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
