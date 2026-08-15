/**
 * Role gate for the diagnostics surface. Roles live in `user_roles`, never on
 * a profile, and are read through the caller's own RLS context.
 */
import type { Database } from "@/integrations/supabase/types";
import { ApiError } from "@/lib/api-errors";
import type { SupabaseClient } from "@supabase/supabase-js";

export type OperatorContext = { supabase: SupabaseClient<Database>; userId: string };

export async function readRoles(context: OperatorContext): Promise<string[]> {
  const { data } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId);
  return (data ?? []).map((row) => row.role as string);
}

export function isOperatorRole(roles: string[]): boolean {
  return roles.includes("admin") || roles.includes("operator");
}

export async function assertOperator(context: OperatorContext): Promise<void> {
  if (!isOperatorRole(await readRoles(context))) {
    throw new ApiError("FORBIDDEN", "This area is restricted to operators.");
  }
}

/** Shape returned by the `observability_summary` SQL rollup. */
export type ObservabilitySummary = {
  window_minutes: number;
  since: string;
  api: {
    requests: number;
    errors: number;
    error_rate: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
  };
  rag: {
    retrieval_p50_ms: number;
    retrieval_p95_ms: number;
    generation_p50_ms: number;
    generation_p95_ms: number;
    answers: number;
    grounded: number;
    refusals: number;
    avg_hits: number;
    avg_best_similarity: number;
    avg_best_rerank: number;
  };
  ingestion: {
    queued: number;
    running: number;
    retrying: number;
    failed: number;
    succeeded: number;
    retries: number;
    avg_duration_ms: number;
  };
  cost: {
    embedding_calls: number;
    embedded_texts: number;
    generation_calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    context_tokens: number;
  };
};
