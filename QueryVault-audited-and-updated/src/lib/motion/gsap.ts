import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

/**
 * The single module GSAP is imported from. Nothing else should import "gsap"
 * directly.
 *
 * Two reasons:
 *
 * 1. Plugins must be registered before use. A bundler is otherwise free to
 *    tree-shake them out, and the failure mode is not a build error — it is a
 *    `scrollTrigger` option that is silently ignored at runtime, so the element
 *    animates immediately on load instead of on scroll. Centralising
 *    registration means that can only be got wrong in one place.
 *
 * 2. This module is reachable from SSR. Importing the plugins on the server is
 *    harmless, but `registerPlugin` runs ScrollTrigger's core init, which
 *    touches `document`. Hence the guard.
 *
 * Since GSAP 3.13 every plugin ships in the public npm package under the
 * standard no-charge licence, so SplitText needs no private registry.
 */
if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, SplitText);
}

export { gsap, ScrollTrigger, SplitText };
