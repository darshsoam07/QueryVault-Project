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
 * Font wait budget for SplitText measurement.
 * Kept between 100–150ms to prevent perceptible delay.
 * If fonts haven't loaded within this window, we skip SplitText to avoid layout shift
 * and animate the headline as a unit.
 */
const FONT_WAIT_MS = 120;

export function Hero() {
  const { session } = useAuth();
  const sectionRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    const content = contentRef.current;
    if (!section || !content) return;
    if (prefersReducedMotion()) return;

    const headline = section.querySelector<HTMLElement>("[data-hero-headline]");
    if (!headline) return;

    let ctx: ReturnType<typeof gsap.context> | undefined;
    let tl: gsap.core.Timeline | undefined;
    let cancelled = false;

    const isFontReady = () => {
      if (typeof document === "undefined" || !document.fonts) return true;
      return (
        document.fonts.status === "loaded" ||
        (typeof document.fonts.check === "function" && document.fonts.check("1em Inter"))
      );
    };

    const build = (fontReady: boolean, synchronous: boolean) => {
      if (cancelled) return;

      ctx = gsap.context(() => {
        // Ensure headline is visible for animation
        gsap.set(headline, { autoAlpha: 1 });

        // SplitText measures line boxes. Only split if font is confirmed ready;
        // otherwise skip SplitText to prevent line breaks from fallback fonts.
        type SplitInstance = ReturnType<typeof SplitText.create>;
        let split: SplitInstance | null = null;
        if (fontReady) {
          try {
            split = SplitText.create(headline, {
              type: "lines",
              mask: "lines",
              aria: "auto",
            });
          } catch {
            split = null;
          }
        }

        tl = gsap.timeline({
          defaults: { ease: EASE.out, duration: DUR.card },
          onComplete: () => {
            split?.revert();
          },
        });

        if (synchronous) {
          // Normal pre-paint path: animate all elements in sequence
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
          } else {
            tl.from(headline, { y: 16, opacity: 0, duration: DUR.hero }, "-=0.15");
          }

          tl.from("[data-hero-sub]", { y: 14, opacity: 0 }, "-=0.55")
            .from("[data-hero-cta]", { y: 14, opacity: 0, stagger: STAGGER.normal }, "-=0.3")
            .from("[data-hero-cue]", { opacity: 0, ease: EASE.soft }, "-=0.2");
        } else {
          // Deferred path: badge, sub, CTA are already visible on screen (no blank hero phase!).
          // Reveal the headline smoothly without resetting already visible elements.
          if (split) {
            tl.from(split.lines, {
              yPercent: 110,
              duration: DUR.hero,
              ease: EASE.expo,
              stagger: STAGGER.loose,
            });
          } else {
            tl.from(headline, {
              y: 16,
              opacity: 0,
              duration: DUR.hero,
              ease: EASE.out,
            });
          }
        }

        // Ambient scroll cue loop
        gsap.to("[data-hero-cue] svg", {
          y: 5,
          duration: 1.1,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        });

        // Ensure content is 100% visible at scroll position 0
        gsap.set(content, { opacity: 1, y: 0 });

        // Hero parallax tied to scroll: starts at "top top" so opacity is strictly 1.0 at scroll 0
        gsap.to(content, {
          y: -36,
          opacity: 0.5,
          ease: "none",
          scrollTrigger: {
            trigger: section,
            start: "top top",
            end: "bottom top",
            scrub: true,
          },
        });
      }, section);
    };

    if (isFontReady()) {
      build(true, true);
    } else {
      // Hide ONLY headline before paint to avoid flash while waiting for fonts.
      // The rest of the hero (badge, sub, CTA) remains visible immediately.
      gsap.set(headline, { autoAlpha: 0 });

      let fontResolved = false;
      const timer = setTimeout(() => {
        if (!fontResolved) {
          fontResolved = true;
          build(false, false);
        }
      }, FONT_WAIT_MS);

      if (document.fonts?.ready) {
        void document.fonts.ready.then(() => {
          if (!fontResolved) {
            fontResolved = true;
            clearTimeout(timer);
            build(true, false);
          }
        });
      }
    }

    return () => {
      cancelled = true;
      tl?.kill();
      ctx?.revert();
      if (headline) {
        gsap.set(headline, { clearProps: "opacity,visibility" });
      }
      gsap.set(content, { clearProps: "opacity,visibility" });
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      className="relative isolate flex min-h-[88vh] items-center overflow-hidden"
    >
      <QueryVaultField />

      {/* Soft radial scrim: attenuates particles directly behind central reading area and CTAs */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[5]"
        style={{
          background:
            "radial-gradient(ellipse 85% 70% at 50% 42%, rgba(5, 6, 7, 0.94) 0%, rgba(5, 6, 7, 0.65) 52%, transparent 85%)",
        }}
      />

      <div
        ref={contentRef}
        className="relative z-10 mx-auto max-w-3xl px-6 pb-24 pt-16 text-center"
      >
        <span
          data-hero-badge
          className="inline-flex items-center gap-2 rounded-full border border-[#1B1F25] bg-[#0B0D10]/70 px-3 py-1 font-mono text-[11px] text-[#686F79]"
        >
          <FileSearch className="h-3 w-3 text-[#63C7FF]" />
          Retrieval-augmented generation
        </span>

        <h1
          data-hero-headline
          className="mt-6 text-5xl font-semibold leading-[1.05] tracking-tight text-[#F3F4F6] sm:text-6xl"
        >
          Your documents,
          <br />
          <span
            style={{
              color: "#63C7FF",
              backgroundImage: "linear-gradient(100deg, #63C7FF, #8BAEFF, #9B8CFF)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            answerable.
          </span>
        </h1>

        <p
          data-hero-sub
          className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-[#A1A7B0]"
        >
          QueryVault indexes your PDFs into a private vector store and answers questions strictly
          from what it retrieves — with page-level citations attached to every response.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button
            data-hero-cta
            size="lg"
            asChild
            className="bg-[#F3F4F6] text-[#050607] font-semibold hover:bg-[#FFFFFF] transition-colors shadow-sm focus-visible:ring-2 focus-visible:ring-[rgba(99,199,255,0.45)]"
          >
            <Link to={session ? "/chat" : "/auth"}>
              {session ? "Open workspace" : "Start querying"}
              <ArrowRight className="ml-1.5 h-4 w-4 text-[#050607]" />
            </Link>
          </Button>
          <Button
            data-hero-cta
            size="lg"
            variant="outline"
            asChild
            className="border-[#1B1F25] bg-[#0B0D10]/80 text-[#A1A7B0] hover:bg-[#0F1216] hover:border-[rgba(99,199,255,0.3)] hover:text-[#F3F4F6] transition-colors focus-visible:ring-2 focus-visible:ring-[rgba(99,199,255,0.45)]"
          >
            <Link to="/reference">View the architecture</Link>
          </Button>
        </div>

        <div
          data-hero-cue
          aria-hidden="true"
          className="mt-16 flex justify-center text-[#63C7FF]/70"
        >
          <ChevronDown className="h-4 w-4" />
        </div>
      </div>
    </section>
  );
}
