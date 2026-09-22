import React from 'react';
import { FileText, ShieldAlert, CheckCircle2, Hash } from 'lucide-react';

export function CitationsSection() {
  return (
    <section id="citations" className="border-b border-zinc-800/80 bg-[#09090b] py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-6 lg:px-8">
        
        {/* Section Header */}
        <div className="max-w-xl">
          <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">
            Source Grounding
          </span>
          <h2 className="mt-2 text-2xl font-normal tracking-[-0.03em] text-zinc-100 sm:text-3xl">
            Every claim traces back to an immutable page.
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-zinc-400">
            Citations are validated server-side against actual retrieved chunks before stream emission. Fabricated citations are rejected at the network boundary.
          </p>
        </div>

        {/* Asymmetric Grouping: 1 Dominant Lead Card + 2 Supporting Cards */}
        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-12">
          
          {/* 1. LEAD CARD (Span 7, Heavy Padding, Focal Interaction) */}
          <div className="lg:col-span-7 rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 transition-all duration-200 ease-out hover:border-zinc-700">
            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
              <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                <FileText className="h-4 w-4 text-zinc-400 stroke-[1.5]" />
                <span>Citation Inspector</span>
              </div>
              <span className="font-mono text-[10px] text-zinc-500">chunk_id: #8491-a</span>
            </div>

            <div className="mt-4 space-y-3">
              <p className="text-xs leading-relaxed text-zinc-300 bg-zinc-950/60 p-3.5 rounded border border-zinc-800/60">
                Operating margin reached 18.4% for the fiscal year{' '}
                <span className="inline-flex items-center rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[11px] text-sky-400">
                  [source_01: p.42]
                </span>
                , driven primarily by consolidation of regional fulfillment hubs{' '}
                <span className="inline-flex items-center rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[11px] text-sky-400">
                  [source_02: p.15]
                </span>
                .
              </p>

              <div className="rounded border border-zinc-800/60 bg-zinc-900/40 p-3 text-[11px]">
                <div className="flex items-center gap-2 text-zinc-400">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 stroke-[1.5]" />
                  <span className="font-medium text-zinc-200">2024_annual_report.pdf (Page 42)</span>
                </div>
                <p className="mt-1 text-zinc-400 font-mono text-[10px]">
                  Matched span: &ldquo;...operating margin improved 340bps to 18.4% across European operations...&rdquo;
                </p>
              </div>
            </div>
          </div>

          {/* 2 & 3. SUPPORTING CARDS (Span 5, Compact Padding, Stacked Vertically) */}
          <div className="lg:col-span-5 flex flex-col gap-4">
            
            {/* Supporting Card A: Cryptographic Verification */}
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-4 transition-all duration-200 ease-out hover:border-zinc-700">
              <div className="flex items-center gap-2">
                <Hash className="h-3.5 w-3.5 text-zinc-400 stroke-[1.5]" />
                <h3 className="text-xs font-medium text-zinc-200">Server-Side Hash Validation</h3>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">
                Chunk hashes are verified against Postgres vector storage prior to rendering. Unmatched citation markers trigger client refusal.
              </p>
            </div>

            {/* Supporting Card B: Refusal Guarantee */}
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 p-4 transition-all duration-200 ease-out hover:border-zinc-700">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-3.5 w-3.5 text-zinc-400 stroke-[1.5]" />
                <h3 className="text-xs font-medium text-zinc-200">Refusal Over Hallucination</h3>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-400">
                If the reranking score falls below the 0.85 floor, the model outputs a deterministic &ldquo;Insufficient evidence&rdquo; message rather than inventing claims.
              </p>
            </div>

          </div>

        </div>

      </div>
    </section>
  );
}
