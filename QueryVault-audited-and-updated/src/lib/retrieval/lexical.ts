import type { RetrievalClient } from "./client";
import type { Candidate } from "./types";

export type LexicalResult = {
  candidates: Candidate[];
  queryLatencyMs: number;
};

/**
 * Lexical retrieval over PostgreSQL full-text search. Complements dense
 * retrieval for exact identifiers, names and numbers that embeddings blur.
 * Tenant isolation lives in the SQL function.
 */
export async function lexicalRetrieve(options: {
  client: RetrievalClient;
  queries: string[];
  userId: string;
  documentIds: string[] | null;
  limit: number;
}): Promise<LexicalResult> {
  const { client, queries, userId, documentIds, limit } = options;

  const start = Date.now();
  const responses = await Promise.all(
    queries.map((query) =>
      client.rpc("lexical_document_chunks", {
        query_text: query,
        requesting_user_id: userId,
        match_count: limit,
        ...(documentIds ? { document_ids: documentIds } : {}),
      }),
    ),
  );
  const queryLatencyMs = Date.now() - start;

  const best = new Map<string, Candidate>();
  for (const response of responses) {
    // A malformed tsquery must not take the whole answer down: dense retrieval
    // still stands on its own.
    if (response.error) continue;
    for (const row of response.data ?? []) {
      const existing = best.get(row.id);
      if (existing && (existing.lexicalRank ?? 0) >= row.lexical_rank) continue;
      best.set(row.id, {
        chunkId: row.id,
        documentId: row.document_id,
        filename: row.filename,
        page: row.page_number,
        chunkIndex: row.chunk_index,
        content: row.content,
        similarity: null,
        lexicalRank: row.lexical_rank,
        densePosition: null,
        lexicalPosition: null,
      });
    }
  }

  const candidates = [...best.values()].sort((a, b) => (b.lexicalRank ?? 0) - (a.lexicalRank ?? 0));
  candidates.forEach((candidate, index) => {
    candidate.lexicalPosition = index + 1;
  });

  return { candidates, queryLatencyMs };
}
