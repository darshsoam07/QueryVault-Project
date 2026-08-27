import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronDown, FileSearch } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { QueryVaultField } from "@/components/visual/QueryVaultField";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { gsap, SplitText } from "@/lib/motion/gsap";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import { DUR, EASE, STAGGER } from "@/lib/motion/tokens";

/**
 * If webfonts stall, build the timeline anyway rather than leave the hero
 * invisible. Inter is loaded from Google Fonts with `display=swap`, so this is a
 * real failure mode on a bad connection, not a theoretical one.
 */
const FONT_WAIT_MS = 700;

export function Hero() {
  const { session } = useAuth();
  const sectionRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    const content = contentRef.current;
    if (!section || !content) return;
    if (prefersReducedMotion()) return;

    /**
     * The start state is set now, synchronously and pre-paint, but the timeline
     * is built after fonts settle.
     *
     * SplitText measures line boxes, so splitting before Inter arrives records
     * line breaks from the fallback font and the reveal comes apart mid-swap.
     * Two tweens can't be merged into one wait, hence the explicit `gsap.set`:
     * without it there would be a visible frame of the finished hero before the
     * animation starts.
     */
    gsap.set(content, { autoAlpha: 0 });

    let ctx: ReturnType<typeof gsap.context> | undefined;
    let cancelled = false;

    const build = () => {
      if (cancelled) return;

      ctx = gsap.context(() => {
        const headline = section.querySelector<HTMLElement>("[data-hero-headline]");
        // `aria: "auto"` labels the parent and hides the fragments, so the
        // headline is still read as one sentence.
        const split = headline
          ? SplitText.create(headline, { type: "lines", mask: "lines", aria: "auto" })
          : null;

        gsap.set(content, { autoAlpha: 1 });

        // One timeline, not five independent tweens: the sequence is the point,
        // and overlapping offsets are only expressible relative to each other.
        const tl = gsap.timeline({
          defaults: { ease: EASE.out, duration: DUR.card },
          onComplete: () => {
            // Hand the DOM back once the reveal is done. The line wrappers hold
            // measurements from one viewport width; leaving them in place would
            // freeze the headline's line breaks against later resizes.
            split?.revert();
          },
        });

        tl.from("[data-hero-badge]", { y: 12, opacity: 0 });

        if (split) {
          tl.from(
            split.lines,
            {
              yPercent: 110,
              duration: DUR.hero,
              ease: EASE.expo,
              stagger: STAGGER.loose,
            },
            "-=0.15",
          );
        }

        tl.from("[data-hero-sub]", { y: 14, opacity: 0 }, "-=0.55")
          .from("[data-hero-cta]", { y: 14, opacity: 0, stagger: STAGGER.normal }, "-=0.3")
          .from("[data-hero-cue]", { opacity: 0, ease: EASE.soft }, "-=0.2");

        /**
         * The one piece of looping motion on the page.
         *
         * It earns it by being an affordance rather than decoration: the hero is
         * roughly viewport-height, so without a cue there is nothing telling the
         * reader the page continues.
         */
        gsap.to("[data-hero-cue] svg", {
          y: 5,
          duration: 1.1,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        });

        /**
         * Hero content recedes as you scroll past it, tied to scroll position
         * rather than played.
         *
         * `ease: "none"` is correct here and is not the `linear` the brief warns
         * about — that warning is about time-driven animation. A scrubbed tween's
         * easing curve maps scroll distance to progress, and anything other than
         * linear makes the content appear to move at a different speed than the
         * finger or wheel that is driving it.
         */
        gsap.to(content, {
          y: -48,
          opacity: 0.1,
          ease: "none",
          scrollTrigger: {
            trigger: section,
            start: "bottom bottom",
            end: "bottom top",
            scrub: true,
          },
        });
      }, section);
    };

    if (document.fonts?.status === "loaded") {
      build();
    } else {
      void Promise.race([
        document.fonts?.ready ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS)),
      ]).then(build);
    }

    return () => {
      cancelled = true;
      ctx?.revert();
      // If we were torn down while still waiting on fonts, ctx never existed and
      // the `set` above would leave the hero hidden.
      gsap.set(content, { clearProps: "opacity,visibility" });
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      className="relative isolate flex min-h-[88vh] items-center overflow-hidden"
    >
      <QueryVaultField />

      <div ref={contentRef} className="relative mx-auto max-w-3xl px-6 pb-24 pt-16 text-center">
        <span
          data-hero-badge
          className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-surface px-3 py-1 font-mono text-[11px] text-muted-foreground"
        >
          <FileSearch className="h-3 w-3 text-cyan" />
          Retrieval-augmented generation
        </span>

        <h1
          data-hero-headline
          className="mt-6 text-4xl font-semibold leading-[1.05] tracking-tight text-foreground sm:text-6xl"
        >
          Your documents,
          <br />
          <span className="text-cyan">answerable.</span>
        </h1>

        <p
          data-hero-sub
          className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted-foreground"
        >
          QueryVault indexes your PDFs into a private vector store and answers questions strictly
          from what it retrieves — with page-level citations attached to every response.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button data-hero-cta size="lg" asChild className="transition-opacity hover:opacity-90">
            <Link to={session ? "/chat" : "/auth"}>
              {session ? "Open workspace" : "Start querying"}
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
          <Button data-hero-cta size="lg" variant="outline" asChild className="bg-surface/40">
            <Link to="/reference">View the architecture</Link>
          </Button>
        </div>

        <div
          data-hero-cue
          aria-hidden="true"
          className="mt-16 flex justify-center text-muted-foreground"
        >
          <ChevronDown className="h-4 w-4" />
        </div>
      </div>
    </section>
  );
}
