import { AppSidebar } from "@/components/queryvault/AppSidebar";
import { VaultMark } from "@/components/queryvault/brand";
import { useAuth } from "@/hooks/useAuth";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState } from "react";

type ChatShellContext = { userId: string; selectedDocs: string[] };

const ShellContext = createContext<ChatShellContext>({ userId: "", selectedDocs: [] });
export const useChatShell = () => useContext(ShellContext);

export const Route = createFileRoute("/chat")({
  head: () => ({
    meta: [
      { title: "Workspace — QueryVault" },
      {
        name: "description",
        content: "Ask questions across your indexed documents and get answers with page citations.",
      },
      { property: "og:title", content: "QueryVault Workspace" },
      {
        property: "og:description",
        content: "Retrieval-augmented answers grounded in your private document library.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ChatShell,
});

function ChatShell() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [selectedDocs, setSelectedDocs] = useState<string[]>([]);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  if (loading || !user) {
    return (
      <div className="grid-void flex h-screen items-center justify-center">
        <VaultMark className="h-10 w-10 animate-pulse" />
      </div>
    );
  }

  return (
    <ShellContext.Provider value={{ userId: user.id, selectedDocs }}>
      <div className="flex h-screen overflow-hidden bg-background">
        <AppSidebar
          userId={user.id}
          email={user.email ?? "account"}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
          selectedDocs={selectedDocs}
          onToggleDoc={(id) =>
            setSelectedDocs((current) =>
              current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
            )
          }
        />
        <div className="grid-void flex min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
      </div>
    </ShellContext.Provider>
  );
}
