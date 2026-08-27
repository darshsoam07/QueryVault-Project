import { VaultMark, Wordmark } from "@/components/queryvault/brand";
import { KnowledgePanel } from "@/components/queryvault/KnowledgePanel";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { fromQueryError, userMessage } from "@/lib/client-errors";
import { gsap } from "@/lib/motion/gsap";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import { DUR, EASE, STAGGER } from "@/lib/motion/tokens";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  BookOpen,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Trash2,
} from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { toast } from "sonner";

export type ThreadRow = { id: string; title: string; updated_at: string };

export function useThreads(userId: string | undefined) {
  return useQuery({
    queryKey: ["threads", userId],
    enabled: Boolean(userId),
    queryFn: async (): Promise<ThreadRow[]> => {
      const { data, error } = await supabase
        .from("threads")
        .select("id, title, updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw fromQueryError(error, "Could not load your conversations.");
      return data ?? [];
    },
  });
}

export function AppSidebar({
  userId,
  email,
  collapsed,
  onToggleCollapsed,
  selectedDocs,
  onToggleDoc,
}: {
  userId: string;
  email: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  selectedDocs: string[];
  onToggleDoc: (id: string) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { threadId?: string };
  const { data: threads = [] } = useThreads(userId);
  const listRef = useRef<HTMLDivElement>(null);
  const hasAnimated = useRef(false);

  const createThread = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from("threads")
        .insert({ user_id: userId, title: "New chat" })
        .select("id")
        .single();
      if (error) throw fromQueryError(error, "Could not start a new conversation.");
      return data.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["threads", userId] });
      navigate({ to: "/chat/$threadId", params: { threadId: id } });
    },
    onError: (error) => toast.error(userMessage(error, "Could not start a new conversation.")),
  });

  const deleteThread = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("threads").delete().eq("id", id);
      if (error) throw fromQueryError(error, "Could not delete that conversation.");
      return id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["threads", userId] });
      if (params.threadId === id) navigate({ to: "/chat" });
    },
    onError: (error) => toast.error(userMessage(error, "Could not delete that conversation.")),
  });

  /**
   * The conversation list arrives asynchronously, so it pops into an empty
   * column. A 200 ms stagger covers that transition and nothing more — this is
   * the workspace, where speed is the feature.
   *
   * `hasAnimated` is the important part. The threads query is invalidated on
   * every create and delete, and re-running the stagger each time a refetch
   * resolved would make the sidebar twitch during ordinary use. It runs once per
   * time the list becomes visible, then never again.
   */
  useLayoutEffect(() => {
    if (hasAnimated.current) return;
    if (threads.length === 0) return;
    const el = listRef.current;
    if (!el) return;

    hasAnimated.current = true;
    if (prefersReducedMotion()) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-thread-row]", {
        x: -8,
        opacity: 0,
        duration: DUR.micro,
        ease: EASE.soft,
        stagger: STAGGER.tight,
      });
    }, el);

    return () => ctx.revert();
  }, [threads.length, collapsed]);

  if (collapsed) {
    return (
      <aside className="flex h-full w-14 shrink-0 flex-col items-center gap-3 border-r border-border/60 bg-sidebar py-4">
        <VaultMark />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleCollapsed}
          aria-label="Expand sidebar"
        >
          <PanelLeftOpen className="text-muted-foreground" />
        </Button>
        <Button
          size="icon-sm"
          onClick={() => createThread.mutate()}
          aria-label="New conversation"
          className="hover:opacity-90"
        >
          <Plus />
        </Button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[288px] shrink-0 flex-col border-r border-border/60 bg-sidebar">
      <div className="flex items-center justify-between px-4 py-3.5">
        <Link to="/" className="flex items-center gap-2">
          <VaultMark />
          <Wordmark />
        </Link>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleCollapsed}
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose className="text-muted-foreground" />
        </Button>
      </div>

      <div className="px-3">
        <Button
          className="w-full justify-start gap-2 hover:opacity-90"
          onClick={() => createThread.mutate()}
          disabled={createThread.isPending}
        >
          <Plus className="h-4 w-4" />
          New conversation
        </Button>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-3">
        <p className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
          Conversations
        </p>
        <div ref={listRef} className="space-y-0.5">
          {threads.length === 0 && (
            <p className="px-1 py-2 text-xs text-muted-foreground">No conversations yet.</p>
          )}
          {threads.map((thread) => {
            const active = params.threadId === thread.id;
            return (
              <div
                key={thread.id}
                data-thread-row
                className={cn(
                  "group flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-sidebar-accent",
                  active && "bg-sidebar-accent",
                )}
              >
                <Link
                  to="/chat/$threadId"
                  params={{ threadId: thread.id }}
                  className="flex min-w-0 flex-1 items-center gap-2"
                >
                  <MessageSquare
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      active ? "text-cyan" : "text-muted-foreground",
                    )}
                  />
                  <span className="truncate text-[13px] text-foreground">{thread.title}</span>
                </Link>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => deleteThread.mutate(thread.id)}
                  aria-label={`Delete ${thread.title}`}
                >
                  <Trash2 className="text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-[1.15] flex-col border-t border-border/60 px-3 py-3">
        <KnowledgePanel userId={userId} selected={selectedDocs} onToggleSelected={onToggleDoc} />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border/70 bg-accent text-[11px] font-semibold text-accent-foreground">
            {email.slice(0, 1).toUpperCase()}
          </div>
          <span className="truncate text-[11px] text-muted-foreground">{email}</span>
        </div>
        <div className="flex items-center">
          <Button variant="ghost" size="icon-sm" asChild aria-label="Python reference">
            <Link to="/reference">
              <BookOpen className="text-muted-foreground" />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Sign out"
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/auth" });
            }}
          >
            <LogOut className="text-muted-foreground" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
