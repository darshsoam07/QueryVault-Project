import { VaultMark, Wordmark } from "@/components/queryvault/brand";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, FileSearch, Layers, Quote, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "QueryVault — Cited answers from your own documents" },
      {
        name: "description",
        content:
          "QueryVault is an enterprise AI knowledge assistant: upload PDFs, ask anything, and get answers grounded in your documents with page-level citations.",
      },
      { property: "og:title", content: "QueryVault — AI Knowledge Assistant" },
      {
        property: "og:description",
        content:
          "Multi-document retrieval-augmented answering with page-level citations and private, per-user indexes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const FEATURES = [
  {
    icon: Layers,
    title: "Multi-document retrieval",
    body: "Chunked at 1000/200 with overlap, embedded into a private pgvector index, and searched with HNSW cosine similarity.",
  },
  {
    icon: Quote,
    title: "Answers you can verify",
    body: "Every claim carries a citation pill back to the exact file and page. Hover to read the retrieved passage.",
  },
  {
    icon: ShieldCheck,
    title: "Private by construction",
    body: "Row-level security scopes documents, chunks and threads to your account. Nobody else can query your vault.",
  },
];

function Landing() {
  const { session } = useAuth();

  return (
    <main className="grid-void min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <VaultMark />
          <Wordmark />
        </div>
        <nav className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/reference">Python reference</Link>
          </Button>
          <Button
            size="sm"
            asChild
            className="bg-gradient-brand text-primary-foreground hover:opacity-90"
          >
            <Link to={session ? "/chat" : "/auth"}>{session ? "Open workspace" : "Sign in"}</Link>
          </Button>
        </nav>
      </header>

      <section className="mx-auto max-w-3xl px-6 pb-16 pt-20 text-center animate-rise">
        <span className="inline-flex items-center gap-2 rounded-full border border-cyan/30 bg-cyan/10 px-3 py-1 font-mono text-[11px] text-foreground">
          <FileSearch className="h-3 w-3 text-cyan" />
          Retrieval-augmented generation
        </span>
        <h1 className="mt-6 text-5xl font-semibold leading-[1.05] tracking-tight text-foreground">
          Your documents,
          <br />
          <span className="text-gradient-brand">answerable.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
          QueryVault indexes your PDFs into a private vector store and answers questions strictly
          from what it retrieves — with page-level citations attached to every response.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Button
            size="lg"
            asChild
            className="bg-gradient-brand text-primary-foreground shadow-[var(--glow-amethyst)] hover:opacity-90"
          >
            <Link to={session ? "/chat" : "/auth"}>
              {session ? "Open workspace" : "Start querying"}
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild className="bg-surface/40">
            <Link to="/reference">View the architecture</Link>
          </Button>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-6 pb-24 md:grid-cols-3">
        {FEATURES.map((feature) => (
          <article key={feature.title} className="glass-panel rounded-2xl p-5">
            <feature.icon className="h-4 w-4 text-cyan" />
            <h2 className="mt-3 text-sm font-semibold text-foreground">{feature.title}</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              {feature.body}
            </p>
          </article>
        ))}
      </section>
    </main>
  );
}
