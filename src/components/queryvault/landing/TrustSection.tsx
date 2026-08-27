import { Ban, Lock, ShieldCheck } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { Reveal } from "@/components/motion/Reveal";
import { gsap } from "@/lib/motion/gsap";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import { DUR, EASE, REVEAL_START } from "@/lib/motion/tokens";

const PILLARS = [
  {
    icon: Ban,
    title: "It refuses rather than guesses",
    body: "When the top rerank score and supporting-chunk count fall below threshold, a fixed refusal is returned without the LLM being called at all. A model handed weak context will still produce a fluent answer — the only reliable fix is not to ask it.",
  },
  {
    icon: ShieldCheck,
    title: "Retrieved text is data, not instructions",
    body: "Evidence is framed to the model as untrusted reference material, and every citation marker is verified server-side against the retrieved set before the message is stored or rendered.",
  },
  {
    icon: Lock,
    title: "Two independent tenancy checks",
    body: "Every table has row-level security scoped to auth.uid(). The retrieval SQL functions also take a requesting_user_id and assert auth.uid() = requesting_user_id inside the function body — deliberately redundant, so a wrong id in application code is still caught.",
  },
] as const;

/**
 * `value` is the number GSAP counts to; the rendered text is generated from the
 * same number, so the DOM already holds the final figure before any JS runs.
 */
const METRICS = [
  { label: "Recall@5", value: 1, decimals: 2 },
  { label: "Recall@10", value: 1, decimals: 2 },
  { label: "MRR", value: 0.925, decimals: 3 },
  { label: "nDCG@10", value: 0.95, decimals: 2 },
  { label: "Citation validity", value: 1, decimals: 2 },
  { label: "Refusal accuracy", value: 1, decimals: 2 },
  { label: "False refusal rate", value: 0, decimals: 2 },
  { label: "Injection defense", value: 1, decimals: 2 },
] as const;

export function TrustSection() {
  const metricsRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = metricsRef.current;
    if (!root) return;
    if (prefersReducedMotion()) return;

    const ctx = gsap.context(() => {
      /**
       * Count-up on the metrics — one of the few places GSAP animates a value
       * rather than a property, and one of the few animations here that does
       * actual work: watching a number settle makes you read it, where a number
       * that is simply present gets skimmed.
       *
       * The final text is already in the HTML, so this overwrites and then lands
       * back on exactly the same string. Nothing is hidden if JS never runs.
       */
      gsap.utils.toArray<HTMLElement>("[data-metric-value]").forEach((el) => {
        const target = Number(el.dataset["value"] ?? "0");
        const decimals = Number(el.dataset["decimals"] ?? "2");
        const counter = { value: 0 };

        gsap.to(counter, {
          value: target,
          duration: DUR.hero,
          ease: EASE.out,
          onUpdate: () => {
            el.textContent = counter.value.toFixed(decimals);
          },
          scrollTrigger: { trigger: root, start: REVEAL_START, once: true },
        });
      });
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <Reveal as="header" className="max-w-2xl">
        <span className="font-mono text-[11px] uppercase tracking-widest text-cyan">
          What it will not do
        </span>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          The useful guarantee is the refusal.
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
          Anything can produce an answer. The parts worth building are the ones that stop it from
          answering when it shouldn&apos;t, and that keep one account&apos;s documents entirely
          invisible to another.
        </p>
      </Reveal>

      <Reveal stagger="loose" className="mt-12 grid gap-4 md:grid-cols-3">
        {PILLARS.map((pillar) => (
          <article key={pillar.title} className="glass-panel rounded-2xl p-5">
            <pillar.icon className="h-4 w-4 text-cyan" />
            <h3 className="mt-3 text-sm font-semibold text-foreground">{pillar.title}</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              {pillar.body}
            </p>
          </article>
        ))}
      </Reveal>

      <div ref={metricsRef} className="mt-16">
        <Reveal as="header" className="max-w-2xl">
          <h3 className="text-lg font-semibold tracking-tight text-foreground">
            Measured, not asserted
          </h3>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
            <code className="rounded bg-surface px-1 py-0.5 font-mono text-[12px]">
              npm run eval
            </code>{" "}
            runs offline — no API keys, no network — across factual lookup, semantic paraphrase,
            cross-document, multi-hop, refusal, and prompt-injection cases.{" "}
            <code className="rounded bg-surface px-1 py-0.5 font-mono text-[12px]">
              npm run eval:gate
            </code>{" "}
            exits non-zero if any metric drops below its floor.
          </p>
        </Reveal>

        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {METRICS.map((metric) => (
            <div key={metric.label} className="glass-panel rounded-xl p-4">
              <dd
                data-metric-value
                data-value={metric.value}
                data-decimals={metric.decimals}
                className="font-mono text-2xl font-semibold tabular-nums text-foreground"
              >
                {metric.value.toFixed(metric.decimals)}
              </dd>
              <dt className="mt-1 text-[11px] uppercase tracking-widest text-muted-foreground">
                {metric.label}
              </dt>
            </div>
          ))}
        </dl>

        {/*
          The caveat is not small print, and it is not optional. Publishing
          "Recall@5 1.00" without the corpus size next to it would be the same
          category of overclaiming the evidence gate exists to prevent.
        */}
        <p className="mt-4 text-[12.5px] leading-relaxed text-muted-foreground/80">
          Measured against a 13-case golden fixture set — a regression signal, not a claim of
          production-scale accuracy. The evidence-gate thresholds are tuned against that same
          fixture set and would need re-measuring on a larger, more diverse corpus.
        </p>
      </div>
    </section>
  );
}
