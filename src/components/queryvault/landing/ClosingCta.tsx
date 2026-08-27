import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { VaultMark, Wordmark } from "@/components/queryvault/brand";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";

/** Verbatim from the stack table in `README.md`. */
const STACK = [
  "TanStack Start (SSR)",
  "React 19",
  "Supabase / Postgres",
  "pgvector · halfvec(3072) · HNSW",
  "Postgres FTS",
  "Zod",
  "Vitest",
] as const;

export function ClosingCta() {
  const { session } = useAuth();

  return (
    <section className="border-t border-border/50">
      <div className="mx-auto max-w-4xl px-6 py-24 text-center">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Point it at your documents.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            Upload a PDF, ask a question, and check the citation. That is the whole evaluation —
            everything else is detail.
          </p>
        </Reveal>

        <Reveal
          stagger="normal"
          delay={0.1}
          className="mt-8 flex items-center justify-center gap-3"
        >
          <Button
            size="lg"
            asChild
            className="bg-foreground text-background font-medium hover:bg-foreground/90 transition-colors"
          >
            <Link to={session ? "/chat" : "/auth"}>
              {session ? "Open workspace" : "Start querying"}
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
          <Button
            size="lg"
            variant="outline"
            asChild
            className="border-border bg-surface/40 text-foreground hover:bg-surface/80"
          >
            <Link to="/reference">Read the reference</Link>
          </Button>
        </Reveal>

        <Reveal stagger="tight" className="mt-14 flex flex-wrap items-center justify-center gap-2">
          {STACK.map((item) => (
            <span
              key={item}
              className="rounded-md border border-border/60 bg-surface/50 px-2 py-1 font-mono text-[10.5px] text-muted-foreground"
            >
              {item}
            </span>
          ))}
        </Reveal>
      </div>

      <footer className="border-t border-border/50">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
          <div className="flex items-center gap-2">
            <VaultMark className="h-5 w-5" />
            <Wordmark className="text-[13px]" />
          </div>
          <nav className="flex items-center gap-5 text-[12.5px] text-muted-foreground">
            <Link to="/reference" className="transition-colors hover:text-foreground">
              Python reference
            </Link>
            <Link
              to={session ? "/chat" : "/auth"}
              className="transition-colors hover:text-foreground"
            >
              {session ? "Workspace" : "Sign in"}
            </Link>
          </nav>
        </div>
      </footer>
    </section>
  );
}
