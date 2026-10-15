import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { createAiSdkProvider, requireAiProvider } from "../ai-gateway.server";
import { verifyAnswerSupport } from "../retrieval/support-verifier.server";
import type { EvidenceSource } from "../retrieval/types";
const enabled =
  process.env["RUN_LIVE_GEMINI_TESTS"] === "1" &&
  process.env["QV_CONFIRMED_FREE_TIER"] === "1" &&
  process.env["QV_LOCAL_ONLY"] !== "1" &&
  !!process.env["GEMINI_API_KEY"];
describe("Live synthetic Gemini support verification", () => {
  it.skipIf(!enabled)(
    "verifies a supported fixture and rejects a fabricated paraphrase",
    async () => {
      const provider = requireAiProvider();
      const model = createAiSdkProvider(provider)(provider.chatModel);
      const sources: EvidenceSource[] = [
        {
          sourceId: "source_01",
          documentId: "fixture",
          chunkId: "fixture",
          filename: "synthetic.txt",
          page: 1,
          snippet: "The notice period is thirty days.",
          similarityScore: 1,
          rerankScore: 1,
        },
      ];
      const metadata: Array<unknown> = [];
      const started = performance.now();
      const verify = (answer: string) =>
        verifyAnswerSupport({
          answer,
          sources,
          model,
          providerId: provider.id,
          modelId: provider.chatModel,
          signal: new AbortController().signal,
          onResult: (result) => metadata.push(result),
        });
      const supported = await verify("The notice period is thirty days [source_01].");
      // Stop acceptance immediately when the availability prerequisite fails.
      // Do not spend more requests on an unavailable provider or count an
      // outage as a successful rejection of a fabricated claim.
      if (!supported) {
        writeFileSync(
          ".verification/phase2-live-verifier.json",
          JSON.stringify(
            {
              provider: provider.id,
              model: provider.chatModel,
              dataset: "synthetic notice-period availability fixture",
              supported,
              fabricated: null,
              acceptanceStopped: true,
              durationMs: Math.round(performance.now() - started),
              metadata,
              limitations: "remaining live cases not run because supported verification failed",
            },
            null,
            2,
          ),
        );
        expect(
          supported,
          "Live availability prerequisite failed; remaining cases were not run",
        ).toBe(true);
      }
      const fabricated = await verify("The notice period is ninety days [source_01].");
      writeFileSync(
        ".verification/phase2-live-verifier.json",
        JSON.stringify(
          {
            provider: provider.id,
            model: provider.chatModel,
            dataset: "two synthetic notice-period fixtures",
            method: "binary entailment with deterministic syntax/quote preflight",
            supported,
            fabricated,
            durationMs: Math.round(performance.now() - started),
            metadata,
            limitations: "two cases, stochastic provider, not a private-corpus quality benchmark",
          },
          null,
          2,
        ),
      );
      expect(supported).toBe(true);
      expect(fabricated).toBe(false);
      expect(metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcome: "supported" }),
          expect.objectContaining({ outcome: "evidence_unsupported" }),
        ]),
      );
    },
    40000,
  );
});
