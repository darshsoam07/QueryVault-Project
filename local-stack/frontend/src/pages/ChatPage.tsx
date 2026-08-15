import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, Copy, Eraser } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import EmptyState from "@/components/EmptyState";
import SourceList from "@/components/SourceList";
import { useDocuments } from "@/hooks/useHealth";
import { api } from "@/lib/api";
import type { Message } from "@/types";

export default function ChatPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { data: documents = [] } = useDocuments();

  const { data: messages = [] } = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => api.listMessages(conversationId!),
    enabled: Boolean(conversationId),
  });

  const ask = useMutation({
    mutationFn: (value: string) =>
      api.chat({ question: value, conversation_id: conversationId ?? null }),
    onSuccess: (response) => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (!conversationId) {
        navigate(`/chat/${response.conversation_id}`, { replace: true });
      } else {
        queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      }
    },
    onError: (err: Error) => setError(err.message),
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, ask.isPending]);

  const submit = () => {
    const value = question.trim();
    if (!value || ask.isPending) return;
    setQuestion("");
    ask.mutate(value);
  };

  const pending: Message[] = ask.isPending
    ? [
        {
          id: "pending-user",
          role: "user",
          content: ask.variables ?? "",
          sources: [],
          created_at: "",
        },
      ]
    : [];

  const readyDocuments = documents.filter((doc) => doc.status === "ready").length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-6 py-3">
        <div>
          <p className="text-sm font-medium">Knowledge Assistant</p>
          <p className="font-mono text-[11px] text-muted">
            {readyDocuments} indexed document{readyDocuments === 1 ? "" : "s"}
          </p>
        </div>
        {conversationId && (
          <button
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[11px] text-muted hover:text-ink"
            onClick={async () => {
              await api.deleteConversation(conversationId);
              queryClient.invalidateQueries({ queryKey: ["conversations"] });
              navigate("/chat");
            }}
          >
            <Eraser size={12} /> Clear conversation
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {messages.length === 0 && !ask.isPending && (
            <EmptyState
              title={
                readyDocuments === 0
                  ? "Your knowledge base is empty."
                  : "Ask anything about your documents."
              }
              description={
                readyDocuments === 0
                  ? "Upload a PDF from the Documents page to start asking questions."
                  : "Answers are generated only from retrieved passages, with page citations."
              }
            />
          )}

          <AnimatePresence initial={false}>
            {[...messages, ...pending].map((message) => (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className={message.role === "user" ? "flex justify-end" : ""}
              >
                {message.role === "user" ? (
                  <div className="max-w-[85%] rounded-2xl bg-elevated px-4 py-2.5 text-[13px]">
                    {message.content}
                  </div>
                ) : (
                  <div>
                    <div className="whitespace-pre-wrap text-[14px] leading-relaxed">
                      {message.content}
                    </div>
                    <button
                      className="mt-2 flex items-center gap-1.5 text-[11px] text-muted hover:text-ink"
                      onClick={() => navigator.clipboard.writeText(message.content)}
                    >
                      <Copy size={12} /> Copy answer
                    </button>
                    <SourceList sources={message.sources} />
                  </div>
                )}
              </motion.div>
            ))}
          </AnimatePresence>

          {ask.isPending && (
            <p className="font-mono text-[11px] text-muted">
              Retrieving passages and generating a grounded answer...
            </p>
          )}

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-300">
              {error}
            </p>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="px-6 pb-6">
        <div className="glass mx-auto flex max-w-2xl items-end gap-2 rounded-2xl px-3 py-2.5">
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Ask anything about your documents..."
            className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-[13px] outline-none placeholder:text-muted"
          />
          <button
            onClick={submit}
            disabled={!question.trim() || ask.isPending}
            aria-label="Send"
            className="rounded-lg bg-ink p-2 text-void disabled:opacity-40"
          >
            <ArrowUp size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
