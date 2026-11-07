import { describe, expect, it, vi, afterEach } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  manifestSchema,
  readiness,
  questionSchema,
  documentSchema,
  TARGETS,
  datasetReviewSchema,
} from "../../../evaluation/benchmark/schema";
import {
  canonical,
  extractFile,
  loadBenchmark,
  sha256,
  validateIntegrity,
  inside,
} from "../../../evaluation/benchmark/load";
import {
  absent,
  aggregate,
  answerMetrics,
  locate,
  measured,
  retrievalMetrics,
  spanCoverage,
} from "../../../evaluation/benchmark/metrics";
import {
  assertContainer,
  assertLocalConfig,
  localConfigSchema,
  restrictedFetch,
} from "../../../evaluation/benchmark/isolation";
import { evaluateBenchmark, safeError } from "../../../evaluation/benchmark/run";
import { applyReviews } from "../../../evaluation/benchmark/review";
import { benchmarkProgress } from "../../../evaluation/benchmark/progress";
import * as productionParser from "../ingestion/document-parser.server";

const sample = "evaluation/benchmark/sample/manifest.json";
const fixture = () => loadBenchmark(sample);
afterEach(() => vi.restoreAllMocks());

describe("private collection progress", () => {
  it("reports all zero categories and split targets without claiming readiness", async () => {
    const report = await benchmarkProgress("evaluation/benchmark/manifest.json");
    expect(report.draftValidity).toBe("valid");
    expect(report.datasetReadiness).toBe("not-ready");
    expect(report.counts.documents).toBe(0);
    expect(report.counts.questions).toBe(0);
    expect(report.counts.evidenceSpans).toBe(0);
    expect(report.counts.reviews.questions.reviewedAttestations).toBe(0);
    expect(report.counts.splits).toEqual({
      development: { total: 0, target: 40 },
      heldOut: { total: 0, target: 20 },
    });
    for (const [category, target] of Object.entries(TARGETS))
      expect(report.counts.categories[category]).toEqual({
        total: 0,
        target,
        development: 0,
        heldOut: 0,
      });
    expect(report.limitations.reviewerIdentity).toBe("not-authenticated");
    expect(report.limitations.semanticAnswerSupport).toBe(
      "not-established-by-automated-validation",
    );
  });
  it("counts sample records and spans without leaking content or identities", async () => {
    const report = await benchmarkProgress(sample);
    const { manifest } = await fixture();
    expect(report.datasetKind).toBe("sample");
    expect(report.datasetReadiness).toBe("not-ready");
    expect(report.counts.documents).toBe(2);
    expect(report.counts.questions).toBe(4);
    expect(report.counts.evidenceSpans).toBe(
      manifest.questions.reduce((sum, q) => sum + q.supportingSpans.length, 0),
    );
    expect(report.counts.reviews.questions).toEqual({
      total: 4,
      reviewedAttestations: 0,
      pending: 4,
      changesRequested: 0,
    });
    const serialized = JSON.stringify(report);
    for (const doc of manifest.documents) {
      expect(serialized).not.toContain(doc.file);
      expect(serialized).not.toContain(doc.provenance.suppliedBy);
    }
    for (const q of manifest.questions) {
      expect(serialized).not.toContain(q.question);
      expect(serialized).not.toContain(q.referenceAnswer);
      for (const span of q.supportingSpans) expect(serialized).not.toContain(span.quote);
    }
  });
  it("refuses invalid worksheets instead of reporting valid progress", async () => {
    await expect(
      benchmarkProgress("evaluation/benchmark/authoring-template.json"),
    ).rejects.toThrow();
  });
});

describe("real-document benchmark schema and provenance", () => {
  it("passes plain Uint8Array bytes to the production parser, never Node Buffer", async () => {
    const parse = vi
      .spyOn(productionParser, "extractDocumentPages")
      .mockImplementation(async (bytes) => {
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(bytes)).toBe(false);
        return [{ page: 1, text: "Parser boundary test" }];
      });
    const result = await extractFile("evaluation/benchmark/sample/policy.txt");
    expect(parse).toHaveBeenCalledOnce();
    expect(Buffer.from(parse.mock.calls[0]![0])).toEqual(result.bytes);
    expect(result.sha256).toBe(sha256(result.bytes));
  });
  it("loads the sample with actual production parsing, stable version/hash, and pending reviews", async () => {
    const loaded = await fixture();
    expect(loaded.manifest.kind).toBe("sample");
    expect(loaded.manifest.version).toBe("0.1.0");
    expect(loaded.datasetHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await fixture()).datasetHash).toBe(loaded.datasetHash);
    expect(loaded.readiness).toContain("REQUIRES_60_REVIEWED_QUESTIONS");
    expect(loaded.readiness).toContain("DOCUMENT_REVIEW_PENDING");
    expect(loaded.pages.get("policy")![0]!.text).toContain("35 days");
    await expect(loadBenchmark(sample, true)).rejects.toThrow("BENCHMARK_NOT_READY");
  });
  it("keeps the real corpus empty and pending, never populated by synthetic examples", async () => {
    const loaded = await loadBenchmark("evaluation/benchmark/manifest.json");
    expect(loaded.manifest.kind).toBe("real");
    expect(loaded.manifest.questions).toHaveLength(0);
    expect(loaded.readiness).toContain("NO_DOCUMENTS");
    await expect(loadBenchmark("evaluation/benchmark/manifest.json", true)).rejects.toThrow();
  });
  it.each(["question", "referenceAnswer"])("rejects empty answerable %s", async (key) => {
    const { manifest } = await fixture();
    (manifest.questions[0] as unknown as Record<string, unknown>)[key] = " ";
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });
  it.each(["category", "difficulty", "split"])("rejects invalid %s", async (key) => {
    const { manifest } = await fixture();
    (manifest.questions[0] as unknown as Record<string, unknown>)[key] = "invalid";
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });
  it("requires real review metadata and consistent answerability", async () => {
    const { manifest } = await fixture();
    manifest.questions[0]!.review = { status: "reviewed" };
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
    manifest.questions[0]!.review = { status: "pending" };
    manifest.questions[0]!.expectedRefusal = true;
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });
  it("does not let duplicate spans masquerade as multi-hop evidence", async () => {
    const { manifest } = await fixture();
    const q = manifest.questions[0]!;
    q.category = "multi-hop";
    q.supportingSpans.push(structuredClone(q.supportingSpans[0]!));
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });
  it.each(["TBD", "TODO", "<reviewer name>", "REPLACE_WITH_REVIEWER", "Your Name"])(
    "rejects placeholder reviewer %s",
    (reviewer) => {
      expect(
        datasetReviewSchema.safeParse({
          status: "reviewed",
          author: "fixture-author",
          reviewer,
          reviewedAt: "2026-11-03T00:00:00Z",
          decision: "approved",
          notes: "Synthetic schema test only.",
        }).success,
      ).toBe(false);
    },
  );
  it("requires independent approval and substantive review fields", () => {
    const signoff = {
      status: "reviewed",
      author: "fixture-author",
      reviewer: "fixture-reviewer",
      reviewedAt: "2026-11-03T00:00:00Z",
      decision: "approved",
      notes: "Synthetic schema test only.",
    };
    expect(datasetReviewSchema.safeParse(signoff).success).toBe(true);
    for (const field of ["author", "reviewer", "reviewedAt", "decision", "notes"]) {
      const incomplete: Record<string, unknown> = { ...signoff };
      delete incomplete[field];
      expect(datasetReviewSchema.safeParse(incomplete).success).toBe(false);
    }
    expect(
      datasetReviewSchema.safeParse({ ...signoff, reviewer: " FIXTURE-AUTHOR " }).success,
    ).toBe(false);
    expect(
      datasetReviewSchema.safeParse({ ...signoff, decision: "changes-requested" }).success,
    ).toBe(false);
    expect(
      datasetReviewSchema.safeParse({ status: "pending", decision: "changes-requested" }).success,
    ).toBe(true);
  });
  it("rejects placeholder provenance and missing negative-case references", async () => {
    const { manifest } = await fixture();
    for (const field of ["origin", "permission", "suppliedBy"] as const) {
      const doc = structuredClone(manifest.documents[0]!);
      doc.provenance[field] = "TBD";
      expect(documentSchema.safeParse(doc).success).toBe(false);
    }
    const negative = manifest.questions.find((q) => !q.answerable)!;
    expect(questionSchema.safeParse({ ...negative, referenceAnswer: " " }).success).toBe(false);
  });
  it("rejects missing provenance and requires independent categories and difficulty", async () => {
    const { manifest } = await fixture();
    expect(manifest.questions[0]!.category).toBe("factual");
    expect(manifest.questions[0]!.difficulty).toBe("easy");
    manifest.documents[0]!.provenance.permission = "";
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
  });
  it("rejects fictional provenance passed off as real", async () => {
    const loaded = await fixture();
    loaded.manifest.kind = "real";
    expect(() => validateIntegrity(loaded.manifest, loaded.pages)).toThrow(
      "SAMPLE_PROVENANCE_IN_REAL_DATASET",
    );
  });
  it("rejects duplicate document and question IDs", async () => {
    const loaded = await fixture();
    loaded.manifest.questions.push(structuredClone(loaded.manifest.questions[0]!));
    expect(() => validateIntegrity(loaded.manifest, loaded.pages)).toThrow("DUPLICATE_QUESTION_ID");
    loaded.manifest.documents.push(structuredClone(loaded.manifest.documents[0]!));
    expect(() => validateIntegrity(loaded.manifest, loaded.pages)).toThrow("DUPLICATE_DOCUMENT_ID");
  });
  it.each(["quote", "start", "end", "page", "documentId"])(
    "rejects tampered span %s",
    async (key) => {
      const loaded = await fixture();
      const span = loaded.manifest.questions[0]!.supportingSpans[0]!;
      (span as unknown as Record<string, unknown>)[key] =
        key === "quote" || key === "documentId" ? "fabricated" : 99999;
      expect(() => validateIntegrity(loaded.manifest, loaded.pages)).toThrow(
        "SOURCE_SPAN_MISMATCH",
      );
    },
  );
  it("rejects file and extraction hash drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "qv-benchmark-"));
    try {
      const { manifest } = await fixture();
      for (const doc of manifest.documents)
        await writeFile(
          join(root, doc.file),
          await readFile(`evaluation/benchmark/sample/${doc.file}`),
        );
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      expect((await loadBenchmark(join(root, "manifest.json"))).datasetHash).toBe(
        sha256(canonical(manifest)),
      );
      manifest.documents[0]!.extractionSha256 = "0".repeat(64);
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      await expect(loadBenchmark(join(root, "manifest.json"))).rejects.toThrow("HASH_MISMATCH");
      await writeFile(join(root, "policy.txt"), "Changed document");
      await expect(loadBenchmark(join(root, "manifest.json"))).rejects.toThrow("HASH_MISMATCH");
    } finally {
      // This test removes only the directory it created under the test temp root.
      expect(root.startsWith(join(tmpdir(), "qv-benchmark-"))).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("canonical hashes ignore object key order, but bind content/version", () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    expect(sha256(canonical({ version: "1" }))).not.toBe(sha256(canonical({ version: "2" })));
  });
  it("rejects documents escaping the manifest root", async () => {
    await expect(inside("evaluation/benchmark/sample", "../schema.ts")).rejects.toThrow(
      "UNSAFE_DOCUMENT_PATH",
    );
    await expect(inside("evaluation/benchmark/sample", "C:\\secret.txt")).rejects.toThrow(
      "UNSAFE_DOCUMENT_PATH",
    );
  });
});

describe("held-out integrity", () => {
  it("rejects normalized duplicates across either split", async () => {
    const loaded = await fixture();
    loaded.manifest.questions[1]!.question = loaded.manifest.questions[0]!.question.toUpperCase();
    expect(() => validateIntegrity(loaded.manifest, loaded.pages)).toThrow(
      "DUPLICATE_QUESTION_TEXT",
    );
  });
  it("rejects shared semantic groups and overlapping gold evidence across splits", async () => {
    const loaded = await fixture();
    loaded.manifest.questions[2]!.leakageGroup = loaded.manifest.questions[0]!.leakageGroup;
    expect(() => validateIntegrity(loaded.manifest, loaded.pages)).toThrow(
      "CROSS_SPLIT_LEAKAGE_GROUP",
    );
    loaded.manifest.questions[2]!.leakageGroup = "different";
    loaded.manifest.questions[2]!.supportingSpans = structuredClone(
      loaded.manifest.questions[0]!.supportingSpans,
    );
    expect(() => validateIntegrity(loaded.manifest, loaded.pages)).toThrow(
      "CROSS_SPLIT_SUPPORT_OVERLAP",
    );
  });
  it("flags high lexical similarity as possible paraphrase leakage", async () => {
    const loaded = await fixture();
    loaded.manifest.questions[2]!.question = `${loaded.manifest.questions[0]!.question} please`;
    expect(() => validateIntegrity(loaded.manifest, loaded.pages)).toThrow(
      "POSSIBLE_CROSS_SPLIT_PARAPHRASE",
    );
  });
  it("readiness enforces all categories and both splits", async () => {
    const { manifest } = await fixture();
    manifest.questions = manifest.questions.filter((q) => q.split === "development");
    expect(readiness(manifest)).toContain("MISSING_SPLIT:held-out");
    expect(readiness(manifest)).toContain("INSUFFICIENT_CATEGORY:adversarial");
  });
  it("requires exactly 60 questions and a 40/20 split, not minimum counts", async () => {
    // Synthetic count-policy fixture only; never persisted as reviewed corpus.
    const { manifest } = await fixture();
    manifest.kind = "real";
    manifest.status = "reviewed";
    const review = {
      status: "reviewed" as const,
      reviewer: "synthetic-test",
      reviewedAt: "2026-11-03T00:00:00Z",
    };
    manifest.documents.forEach((doc) => {
      doc.provenance.kind = "owner-supplied";
      doc.review = review;
    });
    const base = manifest.questions[0]!;
    const devCounts = [10, 7, 7, 6, 7, 3];
    manifest.questions = Object.entries(TARGETS).flatMap(([category, count], categoryIndex) =>
      Array.from({ length: count }, (_, index) => ({
        ...structuredClone(base),
        id: `count-${category}-${index}`,
        category: category as typeof base.category,
        split: index < devCounts[categoryIndex]! ? ("development" as const) : ("held-out" as const),
        review,
      })),
    );
    expect(readiness(manifest)).toEqual([]);
    for (const split of ["development", "held-out"] as const) {
      const oversized = structuredClone(manifest);
      oversized.questions.push({ ...structuredClone(base), split, review });
      expect(readiness(oversized)).toContain("REQUIRES_60_REVIEWED_QUESTIONS");
      expect(readiness(oversized)).toContain(
        `EXCESS_SPLIT:${split}:${split === "development" ? 40 : 20}`,
      );
    }
    const heldOut = manifest.questions.find((q) => q.split === "held-out")!;
    heldOut.split = "development";
    expect(readiness(manifest)).toContain("EXCESS_SPLIT:development:40");
    expect(readiness(manifest)).toContain("INSUFFICIENT_SPLIT:held-out:20");
  });
  it("keeps the blank authoring worksheet invalid and unreviewed", async () => {
    const worksheet = JSON.parse(
      await readFile("evaluation/benchmark/authoring-template.json", "utf8"),
    );
    expect(manifestSchema.safeParse(worksheet).success).toBe(false);
    expect(documentSchema.safeParse(worksheet.document).success).toBe(false);
    expect(questionSchema.safeParse(worksheet.question).success).toBe(false);
    expect(worksheet.document.provenance.providerUseAllowed).toBe(false);
    expect(worksheet.document.review.status).toBe("pending");
    expect(worksheet.question.review.status).toBe("pending");
  });
});

describe("source mapping and metric math", () => {
  it("maps whitespace-normalized chunks to exact original UTF-16 spans", () => {
    const text = "Prefix.\n\n保留35天。\nBackups  last 35 days.";
    const result = locate(
      {
        chunkId: "c",
        documentId: "d",
        page: 1,
        content: "[Section: Backup]\n\n保留35天。 Backups last 35 days.",
      },
      [{ page: 1, text }],
    );
    expect(result.mapping).toBe("exact");
    expect(result.spans[0]!.quote).toBe("保留35天。\nBackups  last 35 days.");
    expect(text.slice(result.spans[0]!.start, result.spans[0]!.end)).toBe(result.spans[0]!.quote);
  });
  it("does not invent offsets for ambiguous or transformed text", () => {
    expect(
      locate({ chunkId: "c", documentId: "d", page: 1, content: "same" }, [
        { page: 1, text: "same same" },
      ]).mapping,
    ).toBe("unavailable");
    expect(
      locate({ chunkId: "c", documentId: "d", page: 1, content: "invented" }, [
        { page: 1, text: "actual" },
      ]).mapping,
    ).toBe("unavailable");
  });
  it("measures retrieval independently, penalizes unfilled top-k slots and missing gold evidence", async () => {
    const loaded = await fixture(),
      q = loaded.manifest.questions[0]!;
    const s = q.supportingSpans[0]!;
    const hit = {
      chunkId: "hit",
      documentId: s.documentId,
      page: s.page,
      spans: [s],
      mapping: "exact" as const,
    };
    const noise = { ...hit, chunkId: "noise", spans: [] };
    const m = retrievalMetrics(q, [hit, noise], [noise, hit], [hit], 5);
    expect(m["recall_at_5"]).toMatchObject({ status: "measured", value: 1 });
    expect(m["precision_at_5"]).toMatchObject({ value: 0.2 });
    expect(m["mrr"]).toMatchObject({ value: 0.5 });
    expect(m["ndcg_at_5"]).toMatchObject({ value: 1 / Math.log2(3) });
    expect(m["final_context_evidence_coverage"]).toMatchObject({ value: 1 });
    expect(retrievalMetrics(q, [], [], [])["recall_at_5"]).toMatchObject({ value: 0 });
    expect(
      retrievalMetrics(q, [{ ...hit, mapping: "unavailable" }], [hit], [hit])["mrr"],
    ).toMatchObject({ status: "unavailable", value: null });
  });
  it("requires complete span coverage, allowing contiguous pieces", async () => {
    const loaded = await fixture(),
      s = loaded.manifest.questions[0]!.supportingSpans[0]!;
    expect(spanCoverage([s], [{ ...s, end: s.end - 1 }])).toBe(0);
    expect(
      spanCoverage(
        [s],
        [
          { ...s, end: s.start + 10 },
          { ...s, start: s.start + 10 },
        ],
      ),
    ).toBe(1);
  });
  it.each([NaN, Infinity, -0.1, 1.1])("rejects non-finite/out-of-range metric %s", (value) => {
    expect(() => measured(value, "test")).toThrow("INVALID_METRIC");
  });
  it("does not turn missing metrics into zero or a perfect score", () => {
    const result = aggregate([
      { score: measured(0.5, "test") },
      { score: absent("unavailable", "error") },
      { score: absent("unmeasured", "no review") },
    ]);
    expect(result["score"]).toMatchObject({
      value: 0.5,
      n: 1,
      total: 3,
      unavailable: 1,
      unmeasured: 1,
    });
    expect(aggregate([{ score: absent("unmeasured", "no review") }])["score"]).toMatchObject({
      value: null,
      status: "unmeasured",
      n: 0,
    });
  });
  it("separates retrieval-only, unavailable generation, and human answer scoring", async () => {
    const q = (await fixture()).manifest.questions[0]!;
    expect(answerMetrics(q, null, null, false)["faithfulness"]).toMatchObject({
      status: "skipped",
    });
    expect(answerMetrics(q, null, null, true)["faithfulness"]).toMatchObject({
      status: "unavailable",
    });
    const m = answerMetrics(q, "35 days. [source_01]", false, true);
    expect(m["reference_exact_match"]).toMatchObject({ value: 1 });
    expect(m["reference_answer_correctness"]).toMatchObject({ status: "unmeasured" });
    expect(m["false_refusal_rate"]).toMatchObject({ value: 0 });
  });
});

const config = () =>
  localConfigSchema.parse({
    projectId: "queryvault-benchmark",
    supabaseUrl: "http://127.0.0.1:54321",
    publishableKey: "test",
    serviceRoleKey: "test",
    provider: {},
  });
describe("live opt-in and production isolation", () => {
  it("blocks provider activity without explicit live opt-in", () => {
    expect(() => assertLocalConfig(config(), false)).toThrow("LIVE_OPT_IN_REQUIRED");
    expect(() => assertLocalConfig(config(), true)).not.toThrow();
  });
  it.each([
    "https://production.supabase.co",
    "http://example.com",
    "http://127.0.0.1:54321@evil.test",
    "http://localhost:54321",
    "http://127.0.0.1:54321/path",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertLocalConfig({ ...config(), supabaseUrl: url }, true)).toThrow();
  });
  it("requires dedicated container identity and loopback binding", () => {
    const container = {
      Name: "/supabase_kong_queryvault-benchmark",
      State: { Running: true },
      Mounts: [],
      NetworkSettings: { Ports: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "54321" }] } },
    };
    expect(() =>
      assertContainer(container, "supabase_kong_queryvault-benchmark", "54321"),
    ).not.toThrow();
    expect(() => assertContainer(container, "supabase_kong_production", "54321")).toThrow();
    expect(() =>
      assertContainer(
        { ...container, Mounts: [{ Type: "bind" }] },
        "supabase_kong_queryvault-benchmark",
        "54321",
      ),
    ).toThrow();
    expect(() =>
      assertContainer(container, "supabase_kong_queryvault-benchmark", "9999"),
    ).toThrow();
  });
  it("blocks unexpected origins and disallows redirects", async () => {
    const delegate = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    const guarded = restrictedFetch(delegate, config().supabaseUrl, "https://provider.example/v1");
    await expect(guarded("https://production.supabase.co/rest/v1/documents")).rejects.toThrow(
      "BENCHMARK_NETWORK_BOUNDARY",
    );
    expect(delegate).not.toHaveBeenCalled();
    await guarded("http://127.0.0.1:54321/rest/v1/documents");
    expect(delegate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: "error" }),
    );
  });
  it("never exposes arbitrary exception bodies", () => {
    expect(safeError(new Error("sk-private provider body"))).toBe("BENCHMARK_OPERATION_FAILED");
    expect(safeError(new Error("PRIVATE_DOCUMENT_TEXT"))).toBe("BENCHMARK_OPERATION_FAILED");
    expect(safeError(new Error("CHAT_HTTP_503"))).toBe("CHAT_HTTP_503");
  });
});

describe("runner and bound human review", () => {
  async function mockRun(generate: boolean) {
    const loaded = await fixture();
    const adapter = {
      indexed: [],
      documentIds: {},
      provider: {
        id: "gemini" as const,
        chatModel: "mock",
        embeddingModel: "mock",
        utilityModel: "mock",
        embeddingDimensions: 1,
        providerModelRevision: null,
      },
      retrieve: vi.fn(async () => {
        throw new Error("RETRIEVAL_FAILED");
      }),
      generate: vi.fn(async () => ({
        answer: "35 days.",
        refused: false,
        citations: [],
        citedSpans: [],
        contextScope: "production-chat-returned-citations-only",
        tokenUsage: null,
        tokenUsageStatus: "unavailable",
        fullGenerationContextStatus: "unavailable",
      })),
      close: vi.fn(),
    };
    return {
      adapter,
      run: await evaluateBenchmark(loaded, adapter, {
        generate,
        split: "development",
        scope: "mocked-contract-test",
      }),
    };
  }
  it("marks mocked runs and never generates in retrieval-only mode", async () => {
    const { run, adapter } = await mockRun(false);
    expect(run.scope).toBe("mocked-contract-test");
    expect(adapter.generate).not.toHaveBeenCalled();
    expect(run.executionStatus).toBe("incomplete");
    expect(run.summary.retrieval["mrr"]).toMatchObject({ status: "unavailable" });
    expect(run.summary.answer["faithfulness"]).toMatchObject({ status: "skipped" });
    expect(adapter.retrieve.mock.calls[0]).toHaveLength(1);
  });
  it("binds reviews to a live scope, run, dataset and exact answer", async () => {
    const { run } = await mockRun(true);
    const row = run.cases[0]!;
    const review = {
      schemaVersion: 1,
      rubricVersion: "human-v1",
      runId: run.runId,
      datasetHash: run.datasetHash,
      judgments: [
        {
          questionId: row.questionId,
          answerHash: row.answerHash,
          review: {
            status: "reviewed",
            reviewer: "test-only reviewer",
            reviewedAt: "2026-11-03T00:00:00Z",
          },
          rationale: "Synthetic unit-test judgment only",
          evidenceScope: "returned-citations-only",
          scores: {
            reference_answer_correctness: 1,
            faithfulness: 1,
            citation_support: 0,
            citation_coverage: 0,
            completeness: 1,
            relevance: 1,
          },
        },
      ],
    };
    expect(() => applyReviews(run, review)).toThrow("REVIEW_RUN_MISMATCH");
    // Test validation logic only; this object is never saved as a live result.
    const liveShaped = { ...run, scope: "isolated-live-chat" as const };
    expect(applyReviews(liveShaped, review).status).toBe("partially-reviewed");
    expect(() => applyReviews(liveShaped, { ...review, datasetHash: "0".repeat(64) })).toThrow(
      "REVIEW_RUN_MISMATCH",
    );
    review.judgments[0]!.answerHash = "0".repeat(64);
    expect(() => applyReviews(liveShaped, review)).toThrow("INVALID_OR_STALE_JUDGMENT");
  });
});
