import { createFileRoute } from "@tanstack/react-router";

import { PublicShell } from "@/components/queryvault/PublicShell";
import { CitationsSection } from "@/components/queryvault/landing/CitationsSection";
import { ClosingCta } from "@/components/queryvault/landing/ClosingCta";
import { Hero } from "@/components/queryvault/landing/Hero";
import { PipelineSection } from "@/components/queryvault/landing/PipelineSection";
import { TrustSection } from "@/components/queryvault/landing/TrustSection";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "QueryVault — Cited answers from your own documents" },
      {
        name: "description",
        content:
          "QueryVault is an enterprise AI knowledge assistant: upload PDFs, ask anything, and get answers grounded in your documents with page-level citations.",
      },
      { property: "og:title", content: "QueryVault — AI Knowledge Assistant" },
      {
        property: "og:description",
        content:
          "Multi-document retrieval-augmented answering with page-level citations and private, per-user indexes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

/**
 * The route file stays a running order. Each section owns its own copy, layout
 * and motion, because the alternative — one file holding five sections and five
 * GSAP contexts — is where landing pages become unmaintainable.
 *
 * Reading order is the argument: what it is → how it works → how you check it →
 * what it refuses to do → try it.
 */
function Landing() {
  return (
    <PublicShell>
      <Hero />
      <PipelineSection />
      <CitationsSection />
      <TrustSection />
      <ClosingCta />
    </PublicShell>
  );
}
