import { VaultMark } from "@/components/queryvault/brand";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { fromQueryError, userMessage } from "@/lib/client-errors";
import { useChatShell } from "@/routes/chat";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/chat/")({
  component: ChatIndex,
});

/** Resolves "/chat" to a real thread URL: newest existing thread, or a fresh one. */
function ChatIndex() {
  const { userId } = useChatShell();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const started = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);

  const resolve = useCallback(async () => {
    if (!userId) return;
    setFailure(null);

    try {
      const { data: existing, error: listError } = await supabase
        .from("threads")
        .select("id")
        .order("updated_at", { ascending: false })
        .limit(1);

      // Previously this error was discarded, so a failed lookup fell through to
      // the insert below and created a duplicate thread on every retry.
      if (listError) throw fromQueryError(listError, "Could not load your conversations.");

      let threadId = existing?.[0]?.id;
      if (!threadId) {
        const { data, error } = await supabase
          .from("threads")
          .insert({ user_id: userId, title: "New chat" })
          .select("id")
          .single();
        if (error || !data) {
          throw fromQueryError(error, "Could not start a conversation.");
        }
        threadId = data.id;
        queryClient.invalidateQueries({ queryKey: ["threads", userId] });
      }

      navigate({ to: "/chat/$threadId", params: { threadId }, replace: true });
    } catch (error) {
      // A dead end used to look identical to loading: the pulse never stopped
      // and the only signal was a toast that had already faded.
      setFailure(userMessage(error, "Could not open a conversation."));
      started.current = false;
    }
  }, [userId, navigate, queryClient]);

  useEffect(() => {
    if (!userId || started.current) return;
    started.current = true;
    void resolve();
  }, [userId, resolve]);

  if (failure) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <VaultMark className="h-8 w-8 opacity-50" />
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{failure}</p>
          <p className="text-xs text-muted-foreground">
            Your documents are safe. This only affects opening the conversation.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => {
            started.current = true;
            void resolve();
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center">
      <VaultMark className="h-10 w-10 animate-pulse" />
    </div>
  );
}
