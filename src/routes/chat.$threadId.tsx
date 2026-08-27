import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { VaultMark } from "@/components/queryvault/brand";
import { useDocuments } from "@/components/queryvault/KnowledgePanel";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import { fromQueryError, userMessage } from "@/lib/client-errors";
import { gsap } from "@/lib/motion/gsap";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import { DUR, EASE, STAGGER } from "@/lib/motion/tokens";
import type { SourceNode } from "@/routes/api/chat";
import { useChatShell } from "@/routes/chat";
import { cn } from "@/lib/utils";
import { useChat } from "@ai-sdk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { DefaultChatTransport, type UIMessage } from "ai";
import { FileText, Layers, Sparkle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/chat/$threadId")({
  component: ThreadPage,
});

type StoredMessage = {
  id: string;
  role: string;
  content: string;
  sources: unknown;
  latency_ms: number | null;
};

function toUIMessage(row: StoredMessage): UIMessage {
  const sources = Array.isArray(row.sources) ? (row.sources as SourceNode[]) : [];
  const parts: UIMessage["parts"] = [];
  if (row.role === "assistant" && sources.length > 0) {
    parts.push({ type: "data-sources", id: "sources", data: sources } as never);
  }
  parts.push({ type: "text", text: row.content });
  return { id: row.id, role: row.role as UIMessage["role"], parts };
}

function extractSources(message: UIMessage): SourceNode[] {
  // Server-validated citations win: they only contain source ids the model
  // actually cited and the server could verify against this request's evidence.
  let fallback: SourceNode[] = [];
  for (const part of message.parts) {
    if (part.type === "data-citations") {
      const data = (part as { data?: { sources?: unknown } }).data;
      if (Array.isArray(data?.sources)) return data.sources as SourceNode[];
    }
    if (part.type === "data-sources") {
      const data = (part as { data?: unknown }).data;
      if (Array.isArray(data)) fallback = data as SourceNode[];
    }
  }
  return fallback;
}

/** Raw retrieval metrics, shown as-is. Never presented as a confidence score. */
function retrievalMetrics(source: SourceNode): string {
  const parts: string[] = [];
  if (typeof source.score === "number") parts.push(`match ${source.score.toFixed(3)}`);
  if (typeof source.rerankScore === "number") parts.push(`rerank ${source.rerankScore.toFixed(2)}`);
  return parts.join(" · ");
}

function SourceRail({ sources }: { sources: SourceNode[] }) {
  const railRef = useRef<HTMLDivElement>(null);
  const hasAnimated = useRef(false);

  /**
   * The pills land after the answer has finished streaming, which is the moment
   * the answer becomes checkable — the one thing in the transcript worth pulling
   * the eye toward. A ~200 ms stagger does that; CSS can't, because the delay has
   * to be per-child and the count isn't known until the sources arrive.
   *
   * Guarded so it runs once per rail. `messages` changes on every streamed token,
   * and re-staggering the pills on each of those would be a strobe.
   */
  useLayoutEffect(() => {
    if (hasAnimated.current) return;
    const el = railRef.current;
    if (!el) return;

    hasAnimated.current = true;
    if (prefersReducedMotion()) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-source-pill]", {
        y: 6,
        opacity: 0,
        duration: DUR.micro,
        ease: EASE.soft,
        stagger: STAGGER.tight,
      });
    }, el);

    return () => ctx.revert();
  }, [sources.length]);

  if (sources.length === 0) return null;
  return (
    <div ref={railRef} className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
        Sources
      </span>
      {sources.map((source, index) => (
        <Popover key={source.id}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-source-pill
              className="group inline-flex items-center gap-1 rounded-md border border-border/70 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:border-cyan/40 hover:bg-cyan/5"
            >
              <span className="text-signal">[{source.sourceId ?? `source_${index + 1}`}]</span>
              <span className="max-w-[140px] truncate">{source.filename}</span>
              <span className="text-muted-foreground">p{source.page}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-96 border-border/70 bg-popover/95 backdrop-blur"
          >
            <div className="flex items-center gap-2 border-b border-border/60 pb-2">
              <FileText className="h-3.5 w-3.5 text-cyan" />
              <span className="truncate text-xs font-medium text-foreground">
                {source.filename}
              </span>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                p{source.page}
                {retrievalMetrics(source) ? ` · ${retrievalMetrics(source)}` : ""}
              </span>
            </div>
            <p className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
              {source.snippet}
            </p>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  );
}

const STARTERS = [
  "Summarise the key findings across my documents",
  "What are the main risks or limitations mentioned?",
  "Compare the conclusions of each document",
];

function ThreadPage() {
  const { threadId } = Route.useParams();
  const { userId, selectedDocs } = useChatShell();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const docsRef = useRef(selectedDocs);
  docsRef.current = selectedDocs;

  const { data: documents = [] } = useDocuments(userId);
  const readyDocs = documents.filter((doc) => doc.status === "ready");

  const { data: history, isLoading } = useQuery({
    queryKey: ["messages", threadId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, role, content, sources, latency_ms")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true });
      if (error) throw fromQueryError(error, "Could not load this conversation.");
      return (data ?? []).map(toUIMessage);
    },
  });

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: async ({ messages }) => {
          const { data } = await supabase.auth.getSession();
          return {
            headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` },
            body: { messages, threadId, documentIds: docsRef.current },
          };
        },
      }),
    [threadId],
  );

  const { messages, sendMessage, setMessages, status, error } = useChat({
    id: threadId,
    transport,
    onError: (chatError) => toast.error(userMessage(chatError, "Something went wrong.")),
    onFinish: () => {
      queryClient.invalidateQueries({ queryKey: ["threads", userId] });
      textareaRef.current?.focus();
    },
  });

  const hydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!history || hydratedFor.current === threadId) return;
    hydratedFor.current = threadId;
    setMessages(history);
    textareaRef.current?.focus();
  }, [history, threadId, setMessages]);

  const busy = status === "submitted" || status === "streaming";

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    if (readyDocs.length === 0) {
      toast.error("Upload and index a PDF first — answers are grounded in your documents.");
      return;
    }
    setInput("");
    void sendMessage({ text: trimmed });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/60 px-6 backdrop-blur">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-cyan" />
          <span className="text-sm font-medium text-foreground">Grounded answering</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="border-border/70 font-mono text-[10px] font-normal">
            {readyDocs.length} indexed
          </Badge>
          <Badge
            variant="outline"
            className="border-cyan/40 bg-cyan/10 font-mono text-[10px] font-normal text-foreground"
          >
            {selectedDocs.length > 0 ? `${selectedDocs.length} scoped` : "all documents"}
          </Badge>
        </div>
      </header>

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl px-6 py-8">
          {isLoading && <p className="text-xs text-muted-foreground">Loading conversation…</p>}

          {!isLoading && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center animate-rise">
              <VaultMark className="h-12 w-12" />
              <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">
                Ask your <span className="text-cyan">knowledge base</span>
              </h1>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                Every answer is retrieved from your indexed PDFs and cited back to the exact page.
                Nothing is fabricated.
              </p>
              <div className="mt-7 grid w-full max-w-lg gap-2">
                {STARTERS.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => send(starter)}
                    className="glass-panel group flex items-center gap-2.5 rounded-lg px-4 py-3 text-left text-[13px] text-muted-foreground transition-colors hover:border-cyan/40 hover:text-foreground"
                  >
                    <Sparkle className="h-3.5 w-3.5 shrink-0 text-cyan" />
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => {
            const sources = extractSources(message);
            const text = message.parts
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("");

            return (
              /*
                `animate-rise` — the existing CSS keyframe — stays for assistant
                messages: transform + opacity, 400 ms, an expo-ish curve. It is
                already what the motion rules ask for, and it costs no JS on a
                path that re-renders on every streamed token.

                It is deliberately *not* applied to the user's own message. They
                just pressed enter; nothing needs to announce that the text
                exists, and an 8px rise there only adds perceived latency at the
                most latency-sensitive moment in the app.
              */
              <Message
                from={message.role}
                key={message.id}
                className={cn(message.role === "assistant" && "animate-rise")}
              >
                <MessageContent
                  className={cn(
                    message.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-transparent p-0 text-foreground",
                  )}
                >
                  {message.role === "assistant" ? (
                    <>
                      <MessageResponse>{text}</MessageResponse>
                      <SourceRail sources={sources} />
                    </>
                  ) : (
                    <span className="whitespace-pre-wrap">{text}</span>
                  )}
                </MessageContent>
              </Message>
            );
          })}

          {status === "submitted" && (
            <Message from="assistant">
              <MessageContent className="bg-transparent p-0">
                <Shimmer>Searching your documents…</Shimmer>
              </MessageContent>
            </Message>
          )}

          {error && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground">
              {userMessage(error, "Something went wrong.")}
            </p>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="shrink-0 border-t border-border/60 px-6 pb-5 pt-4">
        <div className="mx-auto w-full max-w-3xl">
          <PromptInput
            onSubmit={(_message, event) => {
              event.preventDefault();
              send(input);
            }}
          >
            <PromptInputTextarea
              ref={textareaRef}
              value={input}
              autoFocus
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                readyDocs.length === 0
                  ? "Upload a PDF to start querying…"
                  : "Ask anything about your documents…"
              }
            />
            <PromptInputFooter className="justify-between">
              <span className="pl-1 font-mono text-[10px] text-muted-foreground">
                top-k 6 · 1000/200 chunks · cited
              </span>
              <PromptInputSubmit status={status} disabled={!input.trim() || busy} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
