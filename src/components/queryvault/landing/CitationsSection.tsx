import { FileText, Quote } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { gsap } from "@/lib/motion/gsap";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import { DUR, EASE, REVEAL_START, STAGGER } from "@/lib/motion/tokens";

/**
 * A representative answer, shaped exactly like the real thing: the markers in
 * the prose correspond to the pills below it, and the pills carry filename, page
 * and the raw retrieval metrics — which is what `SourceRail` in
 * `src/routes/chat.$threadId.tsx` renders.
 *
 * The scores are shown as scores, never as a confidence percentage. The product
 * does not claim to know how right it is, and neither should the landing page.
 */
const CITED_SOURCES = [
  {
    sourceId: "source_01",
    filename: "2024-annual-report.pdf",
    page: 41,
    metrics: "match 0.842 · rerank 8.60",
    snippet:
      "Operating margin improved to 18.4% for the fiscal year, driven primarily by a reduction in third-party fulfilment costs following the warehouse consolidation completed in Q2.",
  },
  {
    sourceId: "source_02",
    filename: "q3-board-deck.pdf",
    page: 12,
    metrics: "match 0.815 · rerank 8.10",
    snippet:
      "Warehouse consolidation: two regional sites merged into the Rotterdam hub. Run-rate saving of €4.1M annually, fully realised from Q3 onward.",
  },
  {
    sourceId: "source_03",
    filename: "risk-register-2024.pdf",
    page: 7,
    metrics: "match 0.771 · rerank 7.40",
    snippet:
      "Single-hub dependency is recorded as a medium-likelihood, high-impact operational risk. Mitigation is contractual only; no secondary fulfilment site is contracted as of this revision.",
  },
] as const;

export function CitationsSection() {
  const sectionRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    if (prefersReducedMotion()) return;

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        defaults: { ease: EASE.out },
        scrollTrigger: { trigger: "[data-answer-card]", start: REVEAL_START, once: true },
      });

      tl.from("[data-answer-card]", { y: 24, opacity: 0, duration: DUR.card })
        // The markers brighten just before the pills appear, which is the visual
        // claim the whole section is making: these two things are the same thing.
        .from("[data-answer-marker]", {
          opacity: 0,
          duration: DUR.micro,
          stagger: STAGGER.normal,
        })
        .from(
          "[data-source-pill]",
          { y: 8, opacity: 0, duration: DUR.micro, stagger: STAGGER.normal },
          "-=0.1",
        );
    }, section);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} className="border-y border-border/50 bg-surface/20">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-24 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-center">
        <header>
          <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Citations
          </span>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Every claim traces back to a page.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
            Citation markers are validated on the server against the evidence that was actually
            retrieved for that request. A reference the model invented never reaches your screen —
            it is rejected before the message is persisted.
          </p>
          <p className="mt-4 text-[13.5px] leading-relaxed text-muted-foreground">
            Open a pill to read the exact retrieved passage, with its raw match and rerank scores.
            Not a confidence bar — the numbers the retriever actually produced.
          </p>
        </header>

        {/* Same surface treatment as the chat transcript, so what you see here is
            what you get after signing in. */}
        <div data-answer-card className="glass-panel rounded-xl p-5">
          <div className="flex items-center gap-2 border-b border-border/50 pb-3">
            <Quote className="h-3.5 w-3.5 text-cyan" />
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              Assistant
            </span>
          </div>

          <p className="mt-4 text-[13.5px] leading-relaxed text-foreground">
            Operating margin reached 18.4% for the fiscal year
            <Marker id="source_01" />, largely because consolidating two regional warehouses into
            the Rotterdam hub removed about €4.1M of annual run-rate cost
            <Marker id="source_02" />. The risk register flags the resulting single-hub dependency
            as medium-likelihood and high-impact, with no secondary fulfilment site contracted
            <Marker id="source_03" />.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Sources
            </span>
            {CITED_SOURCES.map((source) => (
              <Popover key={source.sourceId}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-source-pill
                    className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:border-cyan/40 hover:bg-cyan/5"
                  >
                    <span className="text-signal">[{source.sourceId}]</span>
                    <span className="max-w-[140px] truncate">{source.filename}</span>
                    <span className="text-muted-foreground">p{source.page}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-96 border-border/70 bg-popover">
                  <div className="flex items-center gap-2 border-b border-border/60 pb-2">
                    <FileText className="h-3.5 w-3.5 text-cyan" />
                    <span className="truncate text-xs font-medium text-foreground">
                      {source.filename}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      p{source.page} · {source.metrics}
                    </span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
                    {source.snippet}
                  </p>
                </PopoverContent>
              </Popover>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Marker({ id }: { id: string }) {
  return (
    <sup
      data-answer-marker
      className="ml-0.5 rounded border border-cyan/40 bg-cyan/10 px-1 font-mono text-[9px] text-signal"
    >
      {id}
    </sup>
  );
}
