/**
 * Operator-only diagnostics API. Every function re-checks the caller's role
 * against `user_roles` through the caller's own RLS context — being signed in
 * is never enough.
 */
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ApiError } from "@/lib/api-errors";
import {
  assertOperator,
  isOperatorRole,
  readRoles,
  type ObservabilitySummary,
} from "@/lib/observability/operator";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** Cheap check the UI uses to decide whether to render the diagnostics shell. */
export const getOperatorStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const roles = await readRoles(context);
    return { isOperator: isOperatorRole(roles), roles };
  });

export const getObservabilitySummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ windowMinutes: z.number().int().min(5).max(10080).default(60) }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertOperator(context);
    const { data: summary, error } = await context.supabase.rpc("observability_summary", {
      window_minutes: data.windowMinutes,
    });
    if (error) throw new ApiError("INTERNAL", "Could not load metrics.");
    return summary as unknown as ObservabilitySummary;
  });

export const listQueryTraces = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        limit: z.number().int().min(1).max(100).default(30),
        onlyRefused: z.boolean().default(false),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertOperator(context);
    let query = context.supabase
      .from("query_traces")
      .select(
        "id, request_id, created_at, question, grounded, refused, gate_reason, reranker, retrieval_latency_ms, generation_latency_ms, total_latency_ms",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.onlyRefused) query = query.eq("refused", true);
    const { data: rows, error } = await query;
    if (error) throw new ApiError("INTERNAL", "Could not load traces.");
    return rows ?? [];
  });

export const getQueryTrace = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ traceId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertOperator(context);
    const { data: trace, error } = await context.supabase
      .from("query_traces")
      .select("*")
      .eq("id", data.traceId)
      .maybeSingle();
    if (error) throw new ApiError("INTERNAL", "Could not load that trace.");
    if (!trace) throw new ApiError("THREAD_NOT_FOUND", "That trace no longer exists.");
    return trace;
  });

export const listRecentEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        limit: z.number().int().min(1).max(200).default(60),
        event: z.string().max(60).nullish(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertOperator(context);
    let query = context.supabase
      .from("telemetry_events")
      .select(
        "id, created_at, event, status, error_code, request_id, document_id, thread_id, latency_ms, attributes",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.event) query = query.eq("event", data.event);
    const { data: rows, error } = await query;
    if (error) throw new ApiError("INTERNAL", "Could not load events.");
    return rows ?? [];
  });
