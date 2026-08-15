import { embedTexts, toVectorLiteral } from "@/lib/ai-gateway.server";
import type { Candidate } from "./types";
import type { RetrievalClient } from "./client";

export type DenseResult = {
  candidates: Candidate[];
  embeddingLatencyMs: number;
  queryLatencyMs: number;
};

/**
 * Dense retrieval over pgvector. Runs one query per rewritten variant and keeps
 * the best similarity per chunk. Tenant isolation is enforced inside the SQL
 * function, not here.
 */
export async function denseRetrieve(options: {
  client: RetrievalClient;
  queries: string[];
  userId: string;
  documentIds: string[] | null;
  limit: number;
  minSimilarity: number;
  apiKey: string;
}): Promise<DenseResult> {
  const { client, queries, userId, documentIds, limit, minSimilarity, apiKey } = options;

  const embedStart = Date.now();
  const embeddings = await embedTexts(queries, apiKey);
  const embeddingLatencyMs = Date.now() - embedStart;

  const queryStart = Date.now();
  const responses = await Promise.all(
    embeddings.map((embedding) =>
      client.rpc("match_document_chunks", {
        query_embedding: toVectorLiteral(embedding),
        requesting_user_id: userId,
        match_count: limit,
        min_similarity: minSimilarity,
        ...(documentIds ? { document_ids: documentIds } : {}),
      }),
    ),
  );
  const queryLatencyMs = Date.now() - queryStart;

  const best = new Map<string, Candidate>();
  for (const response of responses) {
    if (response.error) throw new Error(response.error.message);
    const rows = response.data ?? [];
    rows.forEach((row, index) => {
      if (row.similarity < minSimilarity) return;
      const existing = best.get(row.id);
      if (existing && (existing.similarity ?? 0) >= row.similarity) return;
      best.set(row.id, {
        chunkId: row.id,
        documentId: row.document_id,
        filename: row.filename,
        page: row.page_number,
        chunkIndex: row.chunk_index,
        content: row.content,
        similarity: row.similarity,
        lexicalRank: null,
        densePosition: index + 1,
        lexicalPosition: null,
      });
    });
  }

  const candidates = [...best.values()].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  // Positions are re-derived from the merged ordering so fusion sees one list.
  candidates.forEach((candidate, index) => {
    candidate.densePosition = index + 1;
  });

  return { candidates, embeddingLatencyMs, queryLatencyMs };
}
