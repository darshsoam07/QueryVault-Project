import { VaultMark } from "@/components/queryvault/brand";
import { useDocuments } from "@/components/queryvault/KnowledgePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { fromQueryError, userMessage } from "@/lib/client-errors";
import { useChatShell } from "@/routes/chat";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Layers, Loader2, RotateCcw, Search, Sparkle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/chat/")({
  component: ChatIndex,
});

const STARTERS = [
  "What changed in the latest report?",
  "Summarize the key findings.",
  "Compare these two documents.",
] as const;

/**
 * Empty/new-conversation workspace owned by chat.index.tsx.
 * Presents the SOURCE dashboard search/hero composition with truthful QueryVault
 * assets, light workspace canvas, and real prompt entry.
 */
function ChatIndex() {
  const { userId, selectedDocs } = useChatShell();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: documents = [] } = useDocuments(userId);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const readyDocs = documents.filter((d) => d.status === "ready");

  const handleSubmit = async (queryText: string) => {
    const trimmed = queryText.trim();
    if (!trimmed || submitting) return;

    if (readyDocs.length === 0) {
      toast.error("Upload and index a PDF first — answers are grounded in your documents.");
      return;
    }

    setSubmitting(true);
    setFailure(null);

    try {
      const { data, error } = await supabase
        .from("threads")
        .insert({ user_id: userId, title: trimmed.slice(0, 60) })
        .select("id")
        .single();

      if (error || !data) {
        throw fromQueryError(error, "Could not start a conversation.");
      }

      sessionStorage.setItem(`pending_prompt_${data.id}`, trimmed);
      queryClient.invalidateQueries({ queryKey: ["threads", userId] });
      navigate({ to: "/chat/$threadId", params: { threadId: data.id } });
    } catch (err) {
      setFailure(userMessage(err, "Could not start a conversation."));
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* ── Workspace header ── */}
      <header className="flex h-13 shrink-0 items-center justify-between border-b border-border bg-surface px-6">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-amethyst" />
          <span className="text-sm font-medium text-foreground">Grounded answering</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className="border-border font-mono text-[10px] font-normal text-muted-foreground"
          >
            {readyDocs.length} indexed
          </Badge>
          <Badge
            variant="outline"
            className="border-amethyst/40 bg-amethyst/8 font-mono text-[10px] font-normal text-foreground"
          >
            {selectedDocs.length > 0 ? `${selectedDocs.length} scoped` : "all documents"}
          </Badge>
        </div>
      </header>

      {/* ── Dashboard hero composition ── */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-12">
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center text-center animate-rise">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 shadow-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-amethyst" />
            <span className="technical-label text-muted-foreground">
              Your knowledge, instantly accessible
            </span>
          </div>

          {/* Editorial headline */}
          <div className="mt-6 flex flex-col items-center">
            <VaultMark className="mb-3 h-10 w-10 text-foreground" />
            <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl lg:text-5xl">
              Ask anything across <br />
              <span className="text-gradient-brand">your knowledge.</span>
            </h1>
          </div>

          <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground sm:text-base">
            Search, retrieve, and understand information across your documents with AI-powered
            answers and source citations.
          </p>

          {/* Failure message if thread creation failed */}
          {failure && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/8 px-4 py-2.5 text-xs text-foreground">
              <span>{failure}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={() => handleSubmit(prompt)}
              >
                <RotateCcw className="h-3 w-3" />
                Retry
              </Button>
            </div>
          )}

          {/* Premium search / prompt box */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit(prompt);
            }}
            className="workspace-card group relative mt-8 flex w-full items-center gap-3 p-2 transition-all focus-within:border-amethyst focus-within:ring-2 focus-within:ring-[var(--ring)]"
          >
            <Search className="ml-2.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask a question about your documents…"
              disabled={submitting}
              className="min-w-0 flex-1 bg-transparent py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none sm:text-base"
              autoFocus
            />
            <Button
              type="submit"
              disabled={!prompt.trim() || submitting}
              className="gap-2 bg-primary px-4 text-primary-foreground hover:bg-primary/90"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Starting…</span>
                </>
              ) : (
                <>
                  <span>Analyze</span>
                  <kbd className="hidden rounded bg-white/20 px-1.5 py-0.5 font-mono text-[10px] text-white sm:inline-block">
                    ↵ Enter
                  </kbd>
                  <ArrowRight className="h-3.5 w-3.5 sm:hidden" />
                </>
              )}
            </Button>
          </form>

          {/* Suggested minimal queries */}
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <span className="technical-label text-muted-foreground">Suggestions:</span>
            {STARTERS.map((starter) => (
              <button
                key={starter}
                type="button"
                onClick={() => {
                  setPrompt(starter);
                  void handleSubmit(starter);
                }}
                disabled={submitting}
                className="group flex items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs text-muted-foreground shadow-xs transition-all hover:border-amethyst/50 hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                <Sparkle className="h-3 w-3 text-amethyst transition-transform group-hover:scale-110" />
                <span>{starter}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
