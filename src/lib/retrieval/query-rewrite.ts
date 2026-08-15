import { CHAT_MODEL, GATEWAY_BASE_URL } from "@/lib/ai-gateway.server";
import { RETRIEVAL_CONFIG, type QueryRewriteStrategy } from "./config";
import { contentTerms } from "./reranker";

/**
 * Cheap check for whether a question is worth expanding. Short or vague asks
 * ("how do we scale this?") benefit; a specific question does not, and paying
 * an extra model round-trip for it would only add latency.
 */
export function shouldRewrite(question: string, strategy: QueryRewriteStrategy): boolean {
  if (strategy === "off") return false;
  if (strategy === "always") return true;
  const terms = contentTerms(question);
  if (terms.length <= RETRIEVAL_CONFIG.rewriteWordThreshold) return true;
  // Vague demonstratives with few concrete nouns also read as under-specified.
  return /\b(this|that|these|those|it)\b/i.test(question) && terms.length <= 9;
}

export function sanitizeVariants(
  question: string,
  variants: string[],
  max: number = RETRIEVAL_CONFIG.maxQueryVariants,
): string[] {
  const seen = new Set([question.toLowerCase().trim()]);
  const out = [question];
  for (const variant of variants) {
    const trimmed = String(variant ?? "")
      .trim()
      .slice(0, 200);
    if (trimmed.length < 3) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

const REWRITE_SYSTEM = `You expand a search question into alternative retrieval phrasings.
Return JSON only: {"queries":["...","..."]}. At most 2 alternatives.
Each alternative is a short keyword-style query targeting a different facet of the question.
Never answer the question. Never add facts.`;

/**
 * Returns the query variants to retrieve with. The original question is always
 * first; expansion failures degrade silently to the original query alone.
 */
export async function expandQuery(options: {
  question: string;
  apiKey: string;
  strategy?: QueryRewriteStrategy;
  model?: string;
}): Promise<{ queries: string[]; rewritten: boolean }> {
  const strategy = options.strategy ?? RETRIEVAL_CONFIG.queryRewrite;
  if (!shouldRewrite(options.question, strategy)) {
    return { queries: [options.question], rewritten: false };
  }

  try {
    const response = await fetch(`${GATEWAY_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Lovable-API-Key": options.apiKey },
      body: JSON.stringify({
        model: options.model ?? CHAT_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: REWRITE_SYSTEM },
          { role: "user", content: options.question.slice(0, 1000) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`rewrite_http_${response.status}`);
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = payload.choices?.[0]?.message?.content ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("rewrite_unparsable");
    const parsed = JSON.parse(match[0]) as { queries?: unknown };
    const list = Array.isArray(parsed.queries) ? (parsed.queries as string[]) : [];
    const queries = sanitizeVariants(options.question, list);
    return { queries, rewritten: queries.length > 1 };
  } catch {
    return { queries: [options.question], rewritten: false };
  }
}
