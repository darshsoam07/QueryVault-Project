import React from "react";
import { ArrowUpRight, ChevronRight, ShieldCheck, Terminal } from "lucide-react";
import { QueryVaultField } from "@/components/visual/QueryVaultField";

export function Hero() {
  return (
    <section className="relative min-h-[90vh] w-full overflow-hidden border-b border-white/[0.06] bg-[#09090b] pt-24 pb-20 sm:pt-32 sm:pb-28">
      {/* Background Architectural Canvas & Subtle Vignette */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-40 mix-blend-screen">
        <QueryVaultField />
      </div>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_20%,#09090b_85%)]" />

      {/* Structural Framing Container */}
      <div className="relative mx-auto max-w-5xl px-6 sm:px-8">
        {/* 1. Micro-Metadata / System Status (Replaces generic pill badge) */}
        <div className="flex items-center justify-center">
          <div className="inline-flex items-center gap-2.5 rounded-full border border-white/[0.08] bg-zinc-900/60 px-3 py-1 backdrop-blur-md transition-colors hover:border-white/[0.14]">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/90 shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
            <span className="font-mono text-[11px] tracking-wider text-zinc-400 uppercase">
              RAG Engine v1.2
            </span>
            <span className="h-3 w-[1px] bg-white/[0.1]" />
            <a
              href="#pipeline"
              className="group flex items-center gap-1 font-mono text-[11px] text-zinc-300 transition-colors hover:text-white"
            >
              Zero-leak architecture
              <ChevronRight className="h-3 w-3 text-zinc-500 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-300" />
            </a>
          </div>
        </div>

        {/* 2. Editorial Headline: Scaled down, lighter weight, deliberate tracking */}
        <div className="mt-8 text-center">
          <h1 className="text-3xl sm:text-5xl lg:text-[54px] font-normal tracking-[-0.035em] text-zinc-100 leading-[1.12]">
            Your documents, {/* Elegant metallic sheen gradient instead of neon Canva-violet */}
            <span className="bg-gradient-to-b from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent font-light italic font-serif">
              verifiable.
            </span>
          </h1>

          {/* 3. Subtext: High legibility, bounded width, balanced color contrast */}
          <p className="mx-auto mt-6 max-w-xl text-sm sm:text-base font-normal leading-relaxed text-zinc-400">
            QueryVault indexes unstructured records into private vector stores. Every generation is
            server-verified against strict retrieved evidence — complete with mathematical page
            citations.
          </p>
        </div>

        {/* 4. CTA Group: Precision rounded corners, no oversized jelly pills */}
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href="/auth"
            className="group relative inline-flex h-9 w-full sm:w-auto items-center justify-center gap-2 rounded-md bg-zinc-100 px-4 text-xs font-medium text-zinc-950 shadow-sm transition-all hover:bg-white active:scale-[0.98]"
          >
            <span>Start querying</span>
            <ArrowUpRight className="h-3.5 w-3.5 text-zinc-600 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-zinc-950" />
          </a>

          <a
            href="/reference"
            className="inline-flex h-9 w-full sm:w-auto items-center justify-center gap-2 rounded-md border border-white/[0.08] bg-zinc-900/40 px-4 text-xs font-medium text-zinc-300 backdrop-blur-xs transition-colors hover:border-white/[0.16] hover:bg-zinc-900/80 hover:text-white"
          >
            <span>Python reference</span>
          </a>
        </div>

        {/* 5. Minimalist Spec Bar (Reinforces technical enterprise trust) */}
        <div className="mt-14 pt-6 border-t border-white/[0.05] grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div className="space-y-0.5">
            <span className="font-mono text-[10px] tracking-widest text-zinc-400 uppercase">
              Citation Fidelity
            </span>
            <p className="font-mono text-xs font-medium text-zinc-200">100% Verified</p>
          </div>
          <div className="space-y-0.5">
            <span className="font-mono text-[10px] tracking-widest text-zinc-400 uppercase">
              Vector Isolation
            </span>
            <p className="font-mono text-xs font-medium text-zinc-200">Tenant-Scoped RLS</p>
          </div>
          <div className="space-y-0.5">
            <span className="font-mono text-[10px] tracking-widest text-zinc-400 uppercase">
              Retrieval Fusion
            </span>
            <p className="font-mono text-xs font-medium text-zinc-200">RRF + Bi-Encoder</p>
          </div>
          <div className="space-y-0.5">
            <span className="font-mono text-[10px] tracking-widest text-zinc-400 uppercase">
              Latency Floor
            </span>
            <p className="font-mono text-xs font-medium text-zinc-200">Sub-100ms Index</p>
          </div>
        </div>
      </div>
    </section>
  );
}
