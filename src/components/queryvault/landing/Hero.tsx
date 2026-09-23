import React from 'react';
import { ArrowRight, Terminal, ShieldCheck, CheckCircle2, Lock } from 'lucide-react';

export function Hero() {
  return (
    <section className="relative min-h-[85vh] w-full border-b border-zinc-800/80 bg-[#09090b] pt-20 pb-16 sm:pt-28 sm:pb-24">
      <div className="mx-auto max-w-6xl px-6 lg:px-8">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-12 lg:gap-10">
          
          {/* Left Column: Asymmetric, Left-Aligned Copy */}
          <div className="lg:col-span-7">
            {/* Flat Micro-Pill (No glow, pure structural border) */}
            <div className="inline-flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900/90 px-2.5 py-1 text-[11px] font-mono uppercase tracking-wide text-zinc-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span>Pipeline Engine v1.2</span>
              <span className="text-zinc-600">/</span>
              <span className="text-zinc-300">Deterministic RAG</span>
            </div>

            {/* Flat Solid Typography - Absolutely No Text Gradients */}
            <h1 className="mt-5 text-3xl font-normal tracking-[-0.035em] text-zinc-100 sm:text-5xl lg:text-[52px] leading-[1.12]">
              Your documents, answerable and verified.
            </h1>

            <p className="mt-5 max-w-xl text-sm leading-relaxed text-zinc-400">
              QueryVault indexes PDFs into tenant-isolated vector stores. Answers are emitted exclusively if backed by server-validated page citations.
            </p>

            {/* Action Buttons: Explicit easing, no jelly pills */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href="/auth"
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-zinc-100 px-4 text-xs font-medium text-zinc-950 transition-all duration-200 ease-out hover:bg-white active:scale-[0.98]"
              >
                <span>Start querying</span>
                <ArrowRight className="h-3.5 w-3.5 stroke-[1.5]" />
              </a>

              <a
                href="/reference"
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-3.5 text-xs font-medium text-zinc-300 transition-all duration-200 ease-out hover:border-zinc-700 hover:bg-zinc-900 hover:text-white"
              >
                <Terminal className="h-3.5 w-3.5 text-zinc-500 stroke-[1.5]" />
                <span>Python reference</span>
              </a>
            </div>

            {/* Micro Trust Matrix */}
            <div className="mt-10 flex items-center gap-6 border-t border-zinc-800/80 pt-6 text-[11px] font-mono text-zinc-500">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-zinc-400 stroke-[1.5]" />
                Refuses unsupported answers
              </span>
              <span className="flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 text-zinc-400 stroke-[1.5]" />
                Postgres RLS
              </span>
            </div>
          </div>

          {/* Right Column: Grounded Functional Artifact (Replaces Empty Radial Gradients) */}
          <div className="lg:col-span-5">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
              <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
                <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400">
                  <Terminal className="h-3.5 w-3.5 text-zinc-500 stroke-[1.5]" />
                  <span>retrieval_guard.ts</span>
                </div>
                <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-400">
                  Verified 1.00
                </span>
              </div>

              <div className="mt-4 space-y-3 font-mono text-xs text-zinc-300">
                <div className="text-[11px] text-zinc-500">// 1. Evidence gate evaluation</div>
                <div className="rounded bg-zinc-900/70 p-2.5 text-[11px] leading-relaxed text-zinc-300 border border-zinc-800/60">
                  <span className="text-purple-400">const</span> isVerified = gate.evaluate(&#123;
                  <br />
                  &nbsp;&nbsp;evidence: evidenceSet.retrieved,
                  <br />
                  &nbsp;&nbsp;citations: citations.validated
                  <br />
                  &#125;);
                </div>

                <div className="text-[11px] text-zinc-500">// 2. Deterministic outcome</div>
                <div className="flex items-center gap-2 text-[11px] text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5 stroke-[1.5]" />
                  <span>Pass: Evidence attached to response stream</span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}
