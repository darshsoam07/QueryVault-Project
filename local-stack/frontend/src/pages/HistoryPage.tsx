import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import { Link } from "react-router-dom";

import EmptyState from "@/components/EmptyState";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";

export default function HistoryPage() {
  const { data: conversations = [], error } = useQuery({
    queryKey: ["conversations"],
    queryFn: api.listConversations,
  });

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight">History</h1>

      {error && (
        <p className="mt-6 text-xs text-red-400">{(error as Error).message}</p>
      )}

      <div className="mt-6 space-y-2">
        {!error && conversations.length === 0 && (
          <EmptyState title="No conversations yet." />
        )}
        {conversations.map((conversation) => (
          <Link
            key={conversation.id}
            to={`/chat/${conversation.id}`}
            className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 hover:bg-elevated"
          >
            <MessagesSquare size={15} className="text-cyan" />
            <span className="min-w-0 flex-1 truncate text-[13px]">
              {conversation.title}
            </span>
            <span className="font-mono text-[11px] text-muted">
              {formatDate(conversation.updated_at)}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
