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
      <aside className="flex h-full w-14 shrink-0 flex-col items-center gap-3 border-r border-sidebar-border bg-sidebar py-4 shadow-sm">
        <VaultMark />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleCollapsed}
          aria-label="Expand sidebar"
          className="text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        {/* New conversation — min 44px touch target */}
        <Button
          size="icon-sm"
          onClick={() => navigate({ to: "/chat" })}
          aria-label="New conversation"
          className="h-9 w-9 bg-gradient-brand text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar shadow-sm">
      {/* ── Brand header ── */}
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-sidebar-border">
        <Link to="/" className="flex items-center gap-2.5">
          <VaultMark />
          <Wordmark />
        </Link>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleCollapsed}
          aria-label="Collapse sidebar"
          className="text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>

      {/* ── New conversation ── */}
      <div className="px-3 pt-3">
        <Button
          className="w-full justify-start gap-2 bg-gradient-brand text-primary-foreground shadow-[var(--glow-amethyst)] hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          onClick={() => navigate({ to: "/chat" })}
        >
          <Plus className="h-4 w-4 shrink-0" />
          New conversation
        </Button>
      </div>

      {/* ── Thread list ── */}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2">
        <p className="px-2 pb-1.5 pt-0.5 technical-label text-muted-foreground">Conversations</p>
        <div ref={listRef} className="space-y-px">
          {threads.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">No conversations yet.</p>
          )}
          {threads.map((thread) => {
            const active = params.threadId === thread.id;
            return (
              <div
                key={thread.id}
                data-thread-row
                className={cn(
                  "group flex items-center gap-1 rounded-lg transition-colors hover:bg-accent",
                  active && "bg-accent",
                )}
              >
                {/* Thread link — min 40px touch target via py-2.5 */}
                <Link
                  to="/chat/$threadId"
                  params={{ threadId: thread.id }}
                  className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pl-2.5"
                >
                  <MessageSquare
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      active ? "text-amethyst" : "text-muted-foreground",
                    )}
                  />
                  <span
                    className={cn(
                      "truncate text-[13px]",
                      active ? "font-medium text-foreground" : "text-foreground",
                    )}
                  >
                    {thread.title}
                  </span>
                </Link>
                {/* Delete — min 40px touch target */}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="mr-1 h-8 w-8 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => deleteThread.mutate(thread.id)}
                  aria-label={`Delete ${thread.title}`}
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Knowledge panel ── */}
      <div className="flex min-h-0 flex-[1.15] flex-col border-t border-sidebar-border px-3 py-3">
        <KnowledgePanel userId={userId} selected={selectedDocs} onToggleSelected={onToggleDoc} />
      </div>

      {/* ── User footer ── */}
      <div className="flex items-center justify-between gap-2 border-t border-sidebar-border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {/* Avatar — 28px visual, but the row provides the touch target */}
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-brand text-[11px] font-semibold text-primary-foreground select-none">
            {email.slice(0, 1).toUpperCase()}
          </div>
          <span className="truncate text-[11px] text-muted-foreground">{email}</span>
        </div>
        <div className="flex items-center">
          {/* Reference — min 40px touch target via icon-sm */}
          <Button
            variant="ghost"
            size="icon-sm"
            asChild
            aria-label="Python reference"
            className="text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Link to="/reference">
              <BookOpen className="h-4 w-4" />
            </Link>
          </Button>
          {/* Sign out — min 40px touch target via icon-sm */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Sign out"
            className="text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/auth" });
            }}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
