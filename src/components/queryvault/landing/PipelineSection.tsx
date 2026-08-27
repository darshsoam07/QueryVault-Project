import { useLayoutEffect, useRef } from "react";

import { gsap } from "@/lib/motion/gsap";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import { DUR, EASE, REVEAL_START, STAGGER } from "@/lib/motion/tokens";

/**
 * The nine steps of the pipeline that actually ships, transcribed from
 * `README.md` — not a simplified marketing version of it. If a step is listed
 * here it exists in `src/lib/retrieval/`.
 */
const STEPS: Array<{ title: string; body: string; emphasis?: boolean }> = [
  {
    title: "Query rewriting",
    body: "The raw question is normalised into a retrieval query. Conversational phrasing retrieves badly.",
  },
  {
    title: "Dense retrieval",
    body: "Cosine similarity over halfvec(3072) embeddings, HNSW-indexed.",
  },
  {
    title: "Lexical retrieval",
    body: "Postgres full-text search in parallel. Catches exact identifiers, product codes, and rare terms that embeddings smooth over.",
  },
  {
    title: "Reciprocal Rank Fusion",
    body: "Merges both lists by rank, not score. Cosine similarity and ts_rank are not on comparable scales; averaging them directly is a category error.",
  },
  {
    title: "Reranking",
    body: "An LLM listwise reranker scores the fused candidates, with a deterministic heuristic fallback if that call fails. Retrieval degrades; it does not break.",
  },
  {
    title: "Evidence gate",
    body: "Checks top rerank score and supporting-chunk count. Below threshold the system returns a fixed refusal without calling the LLM at all.",
    emphasis: true,
  },
  {
    title: "Context assembly",
    body: "Token-budgeted, so the prompt cannot overflow and silently truncate the evidence the answer depends on.",
  },
  {
    title: "Generation",
    body: "Streamed, with retrieved evidence framed as untrusted reference data rather than as instructions.",
  },
  {
    title: "Citation validation",
    body: "Every [source_NN] marker is checked server-side against the actually-retrieved set. A citation the model invented is rejected, not displayed.",
  },
];

export function PipelineSection() {
  const sectionRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    if (prefersReducedMotion()) return;

    const ctx = gsap.context(() => {
      /**
       * The rail fills as the list scrolls past — a progress indicator for a
       * nine-item sequence that is taller than the viewport.
       *
       * `scaleY` rather than `height`: a transform is composited, a height change
       * is a layout pass on every scroll frame. This is the single most common
       * way a scroll-linked progress bar destroys a frame budget.
       */
      gsap.fromTo(
        "[data-rail-fill]",
        { scaleY: 0 },
        {
          scaleY: 1,
          ease: "none",
          scrollTrigger: {
            trigger: "[data-rail]",
            start: "top 65%",
            end: "bottom 75%",
            scrub: 0.4,
          },
        },
      );

      /**
       * Steps enter in small batches rather than all nine at once.
       *
       * One ScrollTrigger per step, each firing as that step reaches reading
       * position, so the stagger tracks the reader's pace instead of playing out
       * in a fixed 1.5s burst the moment the section appears.
       */
      gsap.utils.toArray<HTMLElement>("[data-step]").forEach((step) => {
        gsap.from(step, {
          y: 20,
          opacity: 0,
          duration: DUR.card,
          ease: EASE.out,
          scrollTrigger: { trigger: step, start: REVEAL_START, once: true },
        });
        gsap.from(step.querySelectorAll("[data-step-marker]"), {
          scale: 0.6,
          opacity: 0,
          duration: DUR.micro,
          ease: EASE.out,
          stagger: STAGGER.tight,
          scrollTrigger: { trigger: step, start: REVEAL_START, once: true },
        });
      });
    }, section);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} className="mx-auto max-w-4xl px-6 py-24">
      <header className="max-w-2xl">
        <span className="font-mono text-[11px] uppercase tracking-widest text-cyan">
          The pipeline
        </span>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Nine steps between your question and an answer.
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
          Retrieval quality is not one model call. Each stage exists because the one before it fails
          in a specific, observable way.
        </p>
      </header>

      <ol data-rail className="relative mt-14 space-y-8 pl-12">
        {/* Rail track. Absolutely positioned so the fill can scale without
            reflowing the list beside it. */}
        <div aria-hidden="true" className="absolute bottom-2 left-[15px] top-2 w-px bg-border/70">
          <div data-rail-fill className="h-full w-px origin-top bg-cyan/50" />
        </div>

        {STEPS.map((step, index) => (
          <li key={step.title} data-step className="relative">
            <span
              data-step-marker
              aria-hidden="true"
              className={
                step.emphasis
                  ? "absolute -left-12 top-0.5 flex h-8 w-8 items-center justify-center rounded-md border border-cyan/50 bg-cyan/10 font-mono text-[11px] text-foreground"
                  : "absolute -left-12 top-0.5 flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-surface font-mono text-[11px] text-muted-foreground"
              }
            >
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3 className="text-[15px] font-semibold text-foreground">
              {step.title}
              {step.emphasis && (
                <span className="ml-2 rounded border border-cyan/40 bg-cyan/10 px-1.5 py-0.5 align-middle font-mono text-[10px] text-signal">
                  load-bearing
                </span>
              )}
            </h3>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
              {step.body}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
