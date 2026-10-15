import { runRetrieval } from "../src/lib/retrieval/pipeline";
import { heuristicReranker } from "../src/lib/retrieval/reranker";
import type { Candidate } from "../src/lib/retrieval/types";
/** Controlled local fixtures: actual hashing/extraction/chunking; mocked
 * embeddings/index writes. No provider calls, network uploads or cost estimates. */
import { writeFileSync } from "node:fs";
import { UploadQueue } from "../src/lib/upload-queue";
import { sha256Hex } from "../src/lib/documents.policy";
import { extractDocumentPages } from "../src/lib/ingestion/document-parser.server";
import { preparePageChunks } from "../src/lib/chunking";
const results = [];
for (const count of [1, 5, 10, 20]) {
  const queue = new UploadQueue(3),
    embeddingQueue = new UploadQueue(2);
  let active = 0,
    peak = 0,
    peakRss = process.memoryUsage().rss;
  const sample = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 2);
  const stages: Array<{
    hashMs: number;
    extractionMs: number;
    chunkingMs: number;
    mockEmbeddingMs: number;
    mockIndexMs: number;
  }> = [];
  const index = new Map<string, string>();
  const started = performance.now();
  const files = Array.from({ length: count }, (_, i) =>
    new TextEncoder().encode(
      `Document ${i}: The contract notice period is thirty days. `.repeat([40, 300, 1200][i % 3]!),
    ),
  );
  try {
    await Promise.all(
      files.map((bytes, i) =>
        queue.run(async () => {
          active++;
          peak = Math.max(peak, active);
          let time = performance.now();
          await sha256Hex(bytes);
          const hashMs = performance.now() - time;
          time = performance.now();
          const pages = await extractDocumentPages(bytes, `fixture-${i}.txt`);
          const extractionMs = performance.now() - time;
          time = performance.now();
          const chunks = preparePageChunks(pages, 1000, 200);
          const chunkingMs = performance.now() - time;
          time = performance.now();
          await embeddingQueue.run(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
          const mockEmbeddingMs = performance.now() - time;
          time = performance.now();
          for (const chunk of chunks) index.set(`${i}:${chunk.index}`, chunk.content);
          const mockIndexMs = performance.now() - time;
          stages.push({ hashMs, extractionMs, chunkingMs, mockEmbeddingMs, mockIndexMs });
          active--;
        }),
      ),
    );
  } finally {
    clearInterval(sample);
  }
  const candidates: Candidate[] = Array.from(index.entries())
    .filter(([key]) => key.endsWith(":0"))
    .map(([key, content], i) => ({
      chunkId: key,
      documentId: key.split(":")[0]!,
      filename: "fixture.txt",
      page: 1,
      chunkIndex: 0,
      content,
      similarity: 0.9,
      lexicalRank: 1,
      densePosition: i + 1,
      lexicalPosition: i + 1,
    }));
  const retrievalStart = performance.now();
  await runRetrieval("What is the contract notice period?", {
    dense: async () => ({ candidates, embeddingLatencyMs: 0, queryLatencyMs: 0 }),
    lexical: async () => ({ candidates, queryLatencyMs: 0 }),
    expand: async (question) => ({ queries: [question], rewritten: false }),
    reranker: heuristicReranker,
  });
  const fixtureRetrievalMs = Number((performance.now() - retrievalStart).toFixed(2));
  results.push({
    documents: count,
    fixtureRetrievalMs,
    bytes: files.reduce((sum, item) => sum + item.byteLength, 0),
    wallMs: Number((performance.now() - started).toFixed(2)),
    peakActive: peak,
    sampledPeakRssMiB: Number((peakRss / 1048576).toFixed(2)),
    chunks: index.size,
    stages,
    uploadNetworkMs: null,
    liveEmbeddingMs: null,
    databaseIndexingMs: null,
    retrievalLatencyMs: null,
    firstTokenMs: null,
    fullAnswerMs: null,
    externalRequests: 0,
    externalCost: null,
  });
}
const report = {
  runtime: process.version,
  bunVersion: process.versions["bun"] ?? null,
  platform: process.platform,
  kind: "local mixed UTF-8 fixtures; real hash/parse/chunk; embedding/index mocked; not production throughput",
  results,
};
writeFileSync(".verification/phase2-performance.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
