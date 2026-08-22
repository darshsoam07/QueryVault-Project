import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { fromQueryError, userMessage } from "@/lib/client-errors";
import { deleteDocument, reindexDocument, runIngestionWorker } from "@/lib/documents.functions";
import { PHASE_LABELS, phaseProgress, type IngestionPhase } from "@/lib/ingestion/contract";
import { pollIngestion, uploadAndEnqueue, type IngestStatus } from "@/lib/ingest";

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
import { useCallback, useRef, useState } from "react";
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
  const inputRef = useRef<HTMLInputElement>(null);

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
      if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        toast.error("Only PDF files are supported today.");
        return;
      }
      if (file.size > 25 * 1024 * 1024) {
        toast.error("PDFs must be under 25 MB.");
        return;
      }
      upload.mutate(file);
    },
    [upload],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
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
          "group relative cursor-pointer rounded-xl border border-dashed border-border/70 bg-surface/40 px-3 py-5 text-center transition-all",
          dragging && "border-cyan/70 bg-cyan/5",
          upload.isPending && "pointer-events-none opacity-70",
        )}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
        {upload.isPending ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-cyan" />
        ) : (
          <UploadCloud className="mx-auto h-5 w-5 text-muted-foreground transition-colors group-hover:text-cyan" />
        )}
        <p className="mt-2 text-xs font-medium text-foreground">Drop a PDF to index</p>
        <p className="text-[11px] text-muted-foreground">or click to browse · max 25 MB</p>
      </div>

      {progress && (
        <div className="rounded-lg border border-border/60 bg-surface/60 px-3 py-2">
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

      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
          Knowledge base
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{documents.length}</span>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {isLoading && <p className="px-1 text-xs text-muted-foreground">Loading…</p>}
        {!isLoading && documents.length === 0 && (
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            No documents yet. Upload a PDF and QueryVault will chunk, embed, and index it for
            grounded answers.
          </p>
        )}
        {documents.map((doc) => {
          const isSelected = selected.includes(doc.id);
          return (
            <div
              key={doc.id}
              className={cn(
                "group rounded-lg border border-transparent bg-surface/40 px-2.5 py-2 transition-colors hover:bg-surface-raised/70",
                isSelected && "border-amethyst/50 bg-amethyst/10",
              )}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => doc.status === "ready" && onToggleSelected(doc.id)}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                >
                  <FileText
                    className={cn(
                      "mt-0.5 h-3.5 w-3.5 shrink-0",
                      isSelected ? "text-amethyst" : "text-muted-foreground",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">
                      {doc.filename}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      {doc.status === "ready" && (
                        <>
                          <CheckCircle2 className="h-3 w-3 text-cyan" />
                          <span className="font-mono">
                            {doc.chunk_count} chunks · {doc.page_count}p ·{" "}
                            {formatBytes(doc.byte_size)}
                          </span>
                        </>
                      )}
                      {doc.status !== "ready" && doc.status !== "failed" && (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>
                            {phaseLabel(doc.phase)} · step {phaseStep(doc.phase)}
                          </span>
                        </>
                      )}
                      {doc.status === "failed" && (
                        <>
                          <AlertTriangle className="h-3 w-3 text-destructive" />
                          <span className="truncate">
                            {doc.failure_message ?? doc.error_message ?? "Failed"}
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
                {doc.status === "failed" && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => retry.mutate(doc.id)}
                    aria-label={`Retry ${doc.filename}`}
                  >
                    <RotateCcw className="text-muted-foreground hover:text-cyan" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => remove.mutate(doc.id)}
                  aria-label={`Delete ${doc.filename}`}
                >
                  <Trash2 className="text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {selected.length > 0 && (
        <Badge
          variant="outline"
          className="justify-center border-amethyst/40 bg-amethyst/10 text-[11px] font-normal text-foreground"
        >
          Scoped to {selected.length} document{selected.length > 1 ? "s" : ""}
        </Badge>
      )}
    </div>
  );
}
