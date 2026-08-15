/** Pure, testable rate-limit configuration shared by server surfaces. */

export type RateBucket = "chat" | "embed" | "upload";

export type RateRule = { limit: number; windowSeconds: number };

function envInt(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const RATE_LIMITS: Record<RateBucket, RateRule> = {
  chat: { limit: envInt("QV_RATE_CHAT_PER_MIN", 30), windowSeconds: 60 },
  embed: { limit: envInt("QV_RATE_EMBED_PER_MIN", 120), windowSeconds: 60 },
  upload: { limit: envInt("QV_RATE_UPLOAD_PER_5MIN", 12), windowSeconds: 300 },
};

/** Maximum documents a single user may have in-flight through ingestion. */
export const MAX_CONCURRENT_INGESTIONS = envInt("QV_MAX_CONCURRENT_INGESTIONS", 3);

export function rateLimitMessage(bucket: RateBucket): string {
  const rule = RATE_LIMITS[bucket];
  const unit = rule.windowSeconds === 60 ? "minute" : `${rule.windowSeconds / 60} minutes`;
  const what =
    bucket === "chat" ? "questions" : bucket === "embed" ? "indexing requests" : "uploads";
  return `You've hit the limit of ${rule.limit} ${what} per ${unit}. Please slow down and try again shortly.`;
}

export function retryAfterSeconds(bucket: RateBucket, oldestEventAt?: string | null): number {
  const rule = RATE_LIMITS[bucket];
  if (!oldestEventAt) return rule.windowSeconds;
  const elapsed = (Date.now() - new Date(oldestEventAt).getTime()) / 1000;
  return Math.max(1, Math.ceil(rule.windowSeconds - elapsed));
}
