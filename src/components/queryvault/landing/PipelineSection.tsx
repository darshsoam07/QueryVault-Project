import React from "react";
import { GitCommitHorizontal, ShieldCheck } from "lucide-react";

interface Stage {
  id: string;
  name: string;
  desc: string;
  badge: string;
}

const STAGES: Stage[] = [
  {
    id: "01",
    name: "Query rewriting",
    desc: "Raw question is normalized into a retrieval vector. Phrasing artifacts stripped.",
    badge: "Normalization",
  },
  {
    id: "02",
    name: "Dense retrieval",
    desc: "Cosine similarity over halfvec(3072) embeddings using HNSW indexing.",
    badge: "Vector",
  },
  {
    id: "03",
    name: "Lexical retrieval",
    desc: "Postgres full-text search in parallel. Catches exact identifiers and product codes.",
    badge: "BM25 / FTS",
  },
  {
    id: "04",
    name: "Reciprocal Rank Fusion",
    desc: "Merges dense and sparse lists by rank score to prevent score-calibration error.",
    badge: "Fusion",
  },
  {
    id: "05",
    name: "Reranking",
    desc: "Cross-encoder scores candidate documents with deterministic fallback on timeout.",
    badge: "Cross-Encoder",
  },
  {
    id: "06",
    name: "Evidence gate",
    desc: "Answers below the configured evidence threshold are refused.",
    badge: "Guardrail",
  },
  {
    id: "07",
    name: "Context assembly",
    desc: "Token-budgeted prompt construction; prevents context truncation silently.",
    badge: "Token Budget",
  },
  {
    id: "08",
    name: "Streaming generation",
    desc: "Retrieved evidence strictly passed as unprivileged data, not instructions.",
    badge: "Isolated Prompt",
  },
  {
    id: "09",
    name: "Citation validation",
    desc: "Source markers verified server-side against actual retrieval set before emission.",
    badge: "Verification",
  },
];

export function PipelineSection() {
  return (
    <section id="pipeline" className="border-b border-white/[0.06] bg-[#09090b] py-20 sm:py-28">
      <div className="mx-auto max-w-5xl px-6 sm:px-8">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-8">
          {/* Left Sticky Header */}
          <div className="lg:col-span-4 lg:sticky lg:top-24 lg:self-start">
            <div className="inline-flex items-center gap-2 rounded-md border border-white/[0.08] bg-zinc-900/60 px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider text-zinc-400">
              <GitCommitHorizontal className="h-3.5 w-3.5 text-zinc-400" />
              Pipeline Trace
            </div>

            <h2 className="mt-4 text-2xl font-medium tracking-tight text-zinc-100 sm:text-3xl">
              Nine steps between prompt and citation.
            </h2>

            <p className="mt-3 text-xs leading-relaxed text-zinc-400">
              Retrieval quality is a multi-stage verification problem. Each phase isolates failure
              modes before passing context downstream.
            </p>

            <div className="mt-6 flex items-center gap-2 text-[11px] font-mono text-zinc-500">
              <ShieldCheck className="h-4 w-4 text-emerald-400/80" />
              <span>Unsupported answers are refused before generation</span>
            </div>
          </div>

          {/* Right High-Density Execution Graph */}
          <div className="lg:col-span-8">
            <div className="relative border-l border-white/[0.08] pl-6 space-y-6">
              {STAGES.map((stage) => (
                <div key={stage.id} className="group relative">
                  {/* Timeline Node Point */}
                  <div className="absolute -left-[31px] top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950 transition-colors group-hover:border-zinc-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-zinc-500 transition-colors group-hover:bg-zinc-200" />
                  </div>

                  {/* Stage Card */}
                  <div className="rounded-lg border border-white/[0.05] bg-zinc-900/30 p-4 transition-all hover:border-white/[0.12] hover:bg-zinc-900/60">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] text-zinc-500">{stage.id}</span>
                        <h3 className="text-xs font-medium text-zinc-200 group-hover:text-white">
                          {stage.name}
                        </h3>
                      </div>
                      <span className="rounded border border-white/[0.06] bg-zinc-800/50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                        {stage.badge}
                      </span>
                    </div>

                    <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{stage.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
