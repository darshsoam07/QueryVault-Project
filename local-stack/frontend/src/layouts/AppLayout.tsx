import {
  FileText,
  LayoutDashboard,
  Menu,
  MessagesSquare,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

import StatusPill from "@/components/StatusPill";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/chat", label: "Chat", icon: Sparkles },
  { to: "/documents", label: "Documents", icon: FileText },
  { to: "/history", label: "History", icon: MessagesSquare },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function AppLayout() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4 md:px-6">
        <div className="flex items-center gap-3">
          <button
            className="rounded-md p-1.5 text-muted hover:text-ink md:hidden"
            onClick={() => setOpen((value) => !value)}
            aria-label="Toggle navigation"
          >
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-gradient-to-br from-cyan to-amethyst" />
            <span className="text-sm font-semibold tracking-tight">QueryVault</span>
          </div>
        </div>
        <StatusPill />
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          className={cn(
            "w-56 shrink-0 border-r border-line px-3 py-4 md:block",
            open ? "absolute inset-y-14 left-0 z-20 block bg-panel" : "hidden",
          )}
        >
          <p className="px-2 pb-2 text-[11px] uppercase tracking-widest text-muted">
            Workspace
          </p>
          <div className="space-y-0.5">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                    isActive
                      ? "bg-elevated text-ink"
                      : "text-muted hover:bg-elevated/60 hover:text-ink",
                  )
                }
              >
                <Icon size={15} />
                {label}
              </NavLink>
            ))}
          </div>
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
