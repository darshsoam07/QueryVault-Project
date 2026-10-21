import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../documents.functions", () => ({
  getIngestionStatus: mocks.status,
  createDocumentUpload: vi.fn(),
  deleteDocument: vi.fn(),
  enqueueIngestion: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
import { pollIngestion } from "../ingest";
import { classifyError, isRetryable } from "../ingestion/contract";
import { ingestionLeaseState } from "../ingestion/lease";
const handle = { documentId: "doc", jobId: "job" };
const snapshot = (phase = "parsing", status = "processing", jobStatus = "running") => ({
  document: { phase, status, chunk_count: 2, failure_message: null, failure_code: null },
  job: { id: "job", status: jobStatus, attempt_count: 1, error_message: null },
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});
describe("honest ingestion status monitoring", () => {
  it("distinguishes expired, active, unknown and non-running lease snapshots", () => {
    const now = Date.now();
    expect(
      ingestionLeaseState(
        { status: "running", locked_at: new Date(now - 1073000).toISOString() },
        now,
      ),
    ).toBe("expired");
    expect(
      ingestionLeaseState(
        { status: "running", locked_at: new Date(now - 299000).toISOString() },
        now,
      ),
    ).toBe("active");
    expect(ingestionLeaseState({ status: "running", locked_at: null }, now)).toBe("expired");
    expect(ingestionLeaseState({ status: "running", locked_at: "invalid" }, now)).toBe("unknown");
    expect(ingestionLeaseState({ status: "queued" }, now)).toBe("not_running");
  });
  it("shows interrupted running work as recovery pending and follows a later reclaimed attempt", async () => {
    mocks.status
      .mockResolvedValueOnce({ ...snapshot("queued", "uploaded"), leaseState: "expired" })
      .mockResolvedValueOnce({ ...snapshot("parsing"), leaseState: "active" })
      .mockResolvedValueOnce(snapshot("ready", "ready", "succeeded"));
    const onStatus = vi.fn();
    const result = pollIngestion(handle, onStatus, { intervalMs: 1 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await result).toMatchObject({ phase: "ready" });
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Recovery pending",
        refreshState: "recovery_pending",
        failed: false,
      }),
    );
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "parsing", refreshState: "current" }),
    );
  });
  it("makes a disabled zero-cost provider terminal without sending or retrying embeddings", () => {
    const failure = classifyError(
      Object.assign(new Error("disabled"), { code: "ZERO_COST_AI_BLOCKED", status: 503 }),
    );
    expect(failure).toMatchObject({ code: "AI_DISABLED", failureClass: "PERMANENT" });
    expect(isRetryable(failure, 1)).toBe(false);
  });
  it("retains the last confirmed phase and emits a refresh warning after errors", async () => {
    mocks.status.mockResolvedValueOnce(snapshot()).mockRejectedValue(new Error("network"));
    const onStatus = vi.fn();
    const result = pollIngestion(handle, onStatus, { intervalMs: 1 });
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({
      phase: "parsing",
      failed: false,
      refreshState: "unavailable",
    });
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: expect.stringContaining("last confirmed phase: Parsing") }),
    );
    expect(mocks.status).toHaveBeenCalledTimes(4);
  });
  it("recovers a transient status error and reaches actual READY", async () => {
    mocks.status
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(snapshot("ready", "ready", "succeeded"));
    const onStatus = vi.fn();
    const result = pollIngestion(handle, onStatus, { intervalMs: 1 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await result).toMatchObject({ phase: "ready", failed: false });
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ refreshState: "unavailable" }));
  });
  it("bounds a hung status request without declaring ingestion failed", async () => {
    mocks.status
      .mockResolvedValueOnce(snapshot("embedding"))
      .mockImplementation(() => new Promise(() => {}));
    const onStatus = vi.fn();
    const result = pollIngestion(handle, onStatus, { intervalMs: 1, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toMatchObject({
      phase: "embedding",
      failed: false,
      refreshState: "unavailable",
    });
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("last confirmed phase: Embedding"),
      }),
    );
  });
  it("propagates caller cancellation without inventing a failed job", async () => {
    mocks.status.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const onStatus = vi.fn();
    const result = pollIngestion(handle, onStatus, { signal: controller.signal });
    const assertion = expect(result).rejects.toThrow("caller stop");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error("caller stop"));
    await assertion;
    expect(onStatus).not.toHaveBeenCalled();
  });
  it("distinguishes a started worker from a confirmed queue wait", async () => {
    mocks.status
      .mockResolvedValueOnce(snapshot("queued"))
      .mockResolvedValue(snapshot("ready", "ready", "succeeded"));
    const onStatus = vi.fn();
    const result = pollIngestion(handle, onStatus, { intervalMs: 1 });
    await vi.advanceTimersByTimeAsync(5);
    await result;
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "Worker started; waiting for the next confirmed processing phase.",
      }),
    );
  });
  it("shows terminal failure only from an actual failed snapshot", async () => {
    mocks.status.mockResolvedValue({
      ...snapshot("failed", "failed", "failed"),
      document: {
        ...snapshot().document,
        status: "failed",
        phase: "failed",
        failure_code: "AI_DISABLED",
        failure_message: "AI disabled by zero-cost profile",
      },
    });
    const onStatus = vi.fn();
    expect(await pollIngestion(handle, onStatus)).toMatchObject({
      phase: "failed",
      failed: true,
      reason: "AI disabled by zero-cost profile",
    });
  });
});
