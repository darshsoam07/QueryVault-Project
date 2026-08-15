import { VaultMark } from "@/components/queryvault/brand";
import { supabase } from "@/integrations/supabase/client";
import { useChatShell } from "@/routes/chat";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/chat/")({
  component: ChatIndex,
});

/** Resolves "/chat" to a real thread URL: newest existing thread, or a fresh one. */
function ChatIndex() {
  const { userId } = useChatShell();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const started = useRef(false);

  useEffect(() => {
    if (!userId || started.current) return;
    started.current = true;

    void (async () => {
      const { data: existing } = await supabase
        .from("threads")
        .select("id")
        .order("updated_at", { ascending: false })
        .limit(1);

      let threadId = existing?.[0]?.id;
      if (!threadId) {
        const { data, error } = await supabase
          .from("threads")
          .insert({ user_id: userId, title: "New chat" })
          .select("id")
          .single();
        if (error || !data) {
          started.current = false;
          toast.error(error?.message ?? "Could not start a conversation.");
          return;
        }
        threadId = data.id;
        queryClient.invalidateQueries({ queryKey: ["threads", userId] });
      }

      navigate({ to: "/chat/$threadId", params: { threadId }, replace: true });
    })();
  }, [userId, navigate, queryClient]);

  return (
    <div className="flex flex-1 items-center justify-center">
      <VaultMark className="h-10 w-10 animate-pulse" />
    </div>
  );
}
