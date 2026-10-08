import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { fromQueryError, userMessage } from "@/lib/client-errors";
import { deleteDocument, reindexDocument, runIngestionWorker } from "@/lib/documents.functions";
import { PHASE_LABELS, phaseProgress, type IngestionPhase } from "@/lib/ingestion/contract";
import { pollIngestion, uploadAndEnqueue, type IngestStatus } from "@/lib/ingest";
import { isSupportedDocument, MAX_UPLOAD_BYTES } from "@/lib/documents.policy";

import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  RotateCcw,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export type DocumentRow = {
  id: string;
  filename: string;
  status: string;
  phase: string;
  progress: number;
  chunk_count: number;
  page_count: number;
  byte_size: number;
  error_message: string | null;
  failure_message: string | null;
};

export function useDocuments(userId: string | undefined) {
  return useQuery({
    queryKey: ["documents", userId],
    enabled: Boolean(userId),
    queryFn: async (): Promise<DocumentRow[]> => {
      const { data, error } = await supabase
        .from("documents")
        .select(
          "id, filename, status, phase, progress, chunk_count, page_count, byte_size, error_message, failure_message",
        )
        .order("created_at", { ascending: false });
      if (error) throw fromQueryError(error, "Could not load your documents.");
      return data ?? [];
    },
    // While anything is mid-pipeline, follow the real server phases.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((doc) => doc.status !== "ready" && doc.status !== "failed")
        ? 2000
        : false,
  });
}

function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase as IngestionPhase] ?? "Working";
}

function phaseStep(phase: string): string {
  const { step, total } = phaseProgress(phase as IngestionPhase);
  return `${step}/${total}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Returns a status badge variant and label for the exact real ingestion state
 * supplied by the server. No fallback to a generic "Indexed" label —
 * every status must map to a real INGESTION_PHASES value.
 */
function StatusBadge({ status, phase }: { status: string; phase: string }) {
  if (status === "ready") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-600/30 bg-emerald-50 font-mono text-[10px] font-medium text-emerald-800"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
        Ready
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-red-200 bg-red-50 font-mono text-[10px] font-medium text-destructive"
      >
        <AlertTriangle className="h-2.5 w-2.5" />
        Failed
      </Badge>
    );
  }
  // Any mid-pipeline phase — show the exact phase name + step
  return (
    <Badge
      variant="outline"
      className="gap-1 border-amethyst/40 bg-amethyst/6 font-mono text-[10px] font-medium text-foreground"
    >
      <Loader2 className="h-2.5 w-2.5 animate-spin" />
      {phaseLabel(phase)} {phaseStep(phase)}
    </Badge>
  );
}

export function KnowledgePanel({
  userId,
  selected,
  onToggleSelected,
}: {
  userId: string;
  selected: string[];
  onToggleSelected: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: documents = [], isLoading } = useDocuments(userId);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<IngestStatus | null>(null);
  const [filter, setFilter] = useState("");
  const [pageLimit, setPageLimit] = useState(50);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredDocs = useMemo(() => {
    if (!filter.trim()) return documents;
    const q = filter.trim().toLowerCase();
    return documents.filter((doc) => doc.filename.toLowerCase().includes(q));
  }, [documents, filter]);

  const visibleDocs = useMemo(() => {
    return filteredDocs.slice(0, pageLimit);
  }, [filteredDocs, pageLimit]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const handle = await uploadAndEnqueue(file, setProgress);
      queryClient.invalidateQueries({ queryKey: ["documents", userId] });
      return pollIngestion(handle, setProgress);
    },
    onSuccess: (status) => {
      if (status.failed) toast.error(status.reason ?? status.detail);
      else toast.success("Document indexed and ready to query");
      queryClient.invalidateQueries({ queryKey: ["documents", userId] });
      setTimeout(() => setProgress(null), 1500);
    },
    onError: (error) => {
      toast.error(userMessage(error, "That upload could not be indexed."));
      queryClient.invalidateQueries({ queryKey: ["documents", userId] });
      setTimeout(() => setProgress(null), 2500);
    },
  });

  const retry = useMutation({
    mutationFn: async (id: string) => {
      await reindexDocument({ data: { documentId: id } });
      await runIngestionWorker({ data: { maxJobs: 1 } });
    },
    onSuccess: () => {
      toast.success("Reindexing queued");
      queryClient.invalidateQueries({ queryKey: ["documents", userId] });
    },
    onError: (error) => toast.error(userMessage(error, "Could not queue a reindex.")),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await deleteDocument({ data: { documentId: id } });
    },
    onSuccess: () => {
      toast.success("Document removed");
      queryClient.invalidateQueries({ queryKey: ["documents", userId] });
    },
    onError: (error) => {
      toast.error(userMessage(error, "Could not remove that document."));
      queryClient.invalidateQueries({ queryKey: ["documents", userId] });
    },
  });

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      if (!isSupportedDocument(file.name, file.type)) {
        toast.error("Supported: PDF, DOCX, TXT, Markdown, CSV, HTML, XLSX, and PPTX.");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error("Files must be under 25 MB.");
        return;
      }
      upload.mutate(file);
    },
    [upload],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* ── Upload zone ── */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
        className={cn(
          "group relative cursor-pointer rounded-lg border border-dashed border-border bg-background px-3 py-4 text-center transition-all",
          dragging && "border-amethyst/60 bg-amethyst/5",
          upload.isPending && "pointer-events-none opacity-70",
        )}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx,.txt,.md,.markdown,.csv,.html,.htm,.xlsx,.pptx,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv,text/html,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
        {upload.isPending ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-amethyst" />
        ) : (
          <UploadCloud className="mx-auto h-5 w-5 text-muted-foreground transition-colors group-hover:text-amethyst" />
        )}
        <p className="mt-1.5 text-xs font-medium text-foreground">Drop a document to index</p>
        <p className="text-[11px] text-muted-foreground">PDF, Word, text, sheets, slides · max 25 MB</p>
      </div>

      {/* ── Upload progress ── */}
      {progress && (
        <div className="rounded-lg border border-border bg-background px-3 py-2">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span
              className={cn(
                "truncate font-medium",
                progress.failed ? "text-destructive" : "text-foreground",
              )}
            >
              {progress.label}
            </span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {progress.failed ? "failed" : `step ${progress.step}/${progress.totalSteps}`}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {progress.reason ?? progress.detail}
          </p>
          <Progress
            value={progress.failed ? 100 : (progress.step / progress.totalSteps) * 100}
            className="mt-2 h-1"
          />
        </div>
      )}

      {/* ── Section header ── */}
      <div className="flex items-center justify-between px-0.5">
        <span className="technical-label text-muted-foreground">Knowledge base</span>
        <span className="font-mono text-[11px] text-muted-foreground">{documents.length}</span>
      </div>

      {documents.length > 5 && (
        <div className="px-0.5 pt-1">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search documents…"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amethyst"
          />
        </div>
      )}

      {/* ── Document list ── */}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {isLoading && <p className="px-1 text-xs text-muted-foreground">Loading…</p>}
        {!isLoading && documents.length === 0 && (
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            No documents yet. Upload a document and QueryVault will chunk, embed, and index it for
            grounded answers.
          </p>
        )}
        {visibleDocs.map((doc) => {
          const isSelected = selected.includes(doc.id);
          const isReady = doc.status === "ready";
          const isFailed = doc.status === "failed";
          const isProcessing = !isReady && !isFailed;
          return (
            <div
              key={doc.id}
              className={cn(
                "group rounded-lg border border-transparent bg-transparent px-2 py-2 transition-colors hover:bg-accent",
                isSelected && "border-amethyst/40 bg-amethyst/8",
              )}
            >
              <div className="flex items-start gap-2">
                {/* Document button — min 40px effective tap area via py-2 on parent */}
                <button
                  type="button"
                  onClick={() => isReady && onToggleSelected(doc.id)}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                >
                  <FileText
                    className={cn(
                      "mt-0.5 h-3.5 w-3.5 shrink-0",
                      isSelected ? "text-amethyst" : "text-muted-foreground",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-foreground">
                      {doc.filename}
                    </span>
                    {/* Real metadata only — verified against Supabase query fields */}
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={doc.status} phase={doc.phase} />
                      {isReady && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {doc.chunk_count} chunks · {doc.page_count}p ·{" "}
                          {formatBytes(doc.byte_size)}
                        </span>
                      )}
                      {isProcessing && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          step {phaseStep(doc.phase)}
                        </span>
                      )}
                      {isFailed && (
                        <span className="truncate text-[10px] text-muted-foreground">
                          {doc.failure_message ?? doc.error_message ?? "Unknown error"}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
                {/* Retry — only shown on failed documents; min 32px icon-xs */}
                {isFailed && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => retry.mutate(doc.id)}
                    aria-label={`Retry ${doc.filename}`}
                    className="shrink-0 text-muted-foreground hover:text-amethyst"
                  >
                    <RotateCcw />
                  </Button>
                )}
                {/* Delete — always in group hover; min 32px icon-xs */}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => remove.mutate(doc.id)}
                  aria-label={`Delete ${doc.filename}`}
                >
                  <Trash2 className="text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
            </div>
          );
        })}
        {filteredDocs.length > pageLimit && (
          <div className="flex justify-center pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPageLimit((l) => l + 50)}
              className="text-xs text-muted-foreground"
            >
              Show more ({filteredDocs.length - pageLimit} remaining)
            </Button>
          </div>
        )}
      </div>

      {/* ── Scope indicator ── */}
      {selected.length > 0 && (
        <Badge
          variant="outline"
          className="justify-center border-amethyst/40 bg-amethyst/8 font-mono text-[11px] font-normal text-foreground"
        >
          Scoped to {selected.length} document{selected.length > 1 ? "s" : ""}
        </Badge>
      )}
    </div>
  );
}
