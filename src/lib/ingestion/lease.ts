/** Advisory status only. SQL clock and fenced mutations remain authoritative. */
export const INGESTION_LEASE_SECONDS = 300;
export function ingestionLeaseState(
  job: { status: string; locked_at?: string | null } | null,
  observedAt = Date.now(),
): "active" | "expired" | "unknown" | "not_running" {
  if (job?.status !== "running") return "not_running";
  if (job.locked_at === null) return "expired";
  const locked = Date.parse(job.locked_at ?? "");
  if (!Number.isFinite(locked)) return "unknown";
  return observedAt - locked >= INGESTION_LEASE_SECONDS * 1000 ? "expired" : "active";
}
