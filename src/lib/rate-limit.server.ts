import { ApiError } from "@/lib/api-errors";
import {
  RATE_LIMITS,
  rateLimitMessage,
  retryAfterSeconds,
  type RateBucket,
} from "@/lib/rate-limits";

export class RateLimitError extends ApiError {
  readonly retryAfter: number;
  constructor(bucket: RateBucket, retryAfter: number) {
    super("RATE_LIMITED", rateLimitMessage(bucket));
    this.retryAfter = retryAfter;
  }
}

/** Raised when limiter state cannot be read or written — the caller must fail closed. */
export class RateLimitUnavailableError extends ApiError {
  constructor() {
    super("RATE_LIMIT_UNAVAILABLE", "Request throttling is temporarily unavailable. Try again.");
  }
}

/**
 * Application-level sliding-window limiter backed by `rate_limit_events`.
 *
 * The table is server-owned: the browser has no grants on it at all, so a user
 * cannot delete, forge or backdate their own limiter history. All reads and
 * writes go through the service-role client, which never leaves the server.
 *
 * Fails CLOSED: if limiter state cannot be read or recorded, the request is
 * denied rather than allowed.
 */
export async function enforceRateLimit(userId: string, bucket: RateBucket): Promise<void> {
  const rule = RATE_LIMITS[bucket];
  const since = new Date(Date.now() - rule.windowSeconds * 1000).toISOString();

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data, error } = await supabaseAdmin
    .from("rate_limit_events")
    .select("created_at")
    .eq("user_id", userId)
    .eq("bucket", bucket)
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (error) {
    console.error(JSON.stringify({ level: "error", event: "rate_limit.read_failed", bucket }));
    throw new RateLimitUnavailableError();
  }

  if ((data?.length ?? 0) >= rule.limit) {
    throw new RateLimitError(bucket, retryAfterSeconds(bucket, data?.[0]?.created_at));
  }

  const { error: writeError } = await supabaseAdmin
    .from("rate_limit_events")
    .insert({ user_id: userId, bucket });
  if (writeError) {
    console.error(JSON.stringify({ level: "error", event: "rate_limit.write_failed", bucket }));
    throw new RateLimitUnavailableError();
  }

  // Opportunistic pruning keeps the table small without a cron job.
  if (Math.random() < 0.05) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await supabaseAdmin
      .from("rate_limit_events")
      .delete()
      .eq("user_id", userId)
      .lt("created_at", cutoff);
  }
}

/* ========================= Phase 5: IP-level burst protection ========================= */

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Phase 5: per-IP burst check. Call before JWT auth. Fails open. */
export async function enforceIpRateLimit(ip: string): Promise<RateLimitResult> {
  try {
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    // RPC added by migration 0015; not yet in generated types — cast to never.
    const { data, error } = await admin.rpc("check_ip_rate_limit" as never, { p_ip: ip } as never);
    if (error) {
      console.error("[rate-limit] check_ip_rate_limit RPC failed:", error.message);
      return { allowed: true };
    }
    const result = data as { allowed?: boolean; retry_after_seconds?: number } | null;
    if (!result?.allowed) {
      return { allowed: false, retryAfterSeconds: result?.retry_after_seconds ?? 10 };
    }
    return { allowed: true };
  } catch (err) {
    console.error("[rate-limit] ip burst check error:", err);
    return { allowed: true };
  }
}

/** Phase 5+6: delete stale rate-limit counters. Called from worker drain. */
export async function pruneExpiredRateLimits(): Promise<void> {
  try {
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    // RPC added by migration 0015; not yet in generated types — cast to never.
    const { error } = await admin.rpc("prune_expired_rate_limits" as never);
    if (error) console.error("[rate-limit] prune RPC failed:", error.message);
  } catch (err) {
    console.error("[rate-limit] prune error:", err);
  }
}
