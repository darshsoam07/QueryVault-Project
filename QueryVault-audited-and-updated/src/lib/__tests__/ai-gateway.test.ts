import { describe, expect, it } from "vitest";
import {
  GatewayError,
  gatewayMessageForStatus,
  parseProviderErrorBody,
} from "@/lib/ai-gateway.server";
import {
  classifyError,
  isCreditsOrQuotaExhausted,
  isInvalidCredentialsError,
  isRetryable,
  backoffSeconds,
} from "@/lib/ingestion/contract";

describe("AI Gateway error body parsing", () => {
  it("safely parses standard OpenAI error format with code and type", () => {
    const raw = JSON.stringify({
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        param: null,
        code: "credit_balance_exhausted",
      },
    });
    const parsed = parseProviderErrorBody(raw);
    expect(parsed.code).toBe("credit_balance_exhausted");
    expect(parsed.type).toBe("insufficient_quota");
    expect(parsed.rawMessage).toContain("exceeded your current quota");
  });

  it("safely parses Anthropic-style error envelope", () => {
    const raw = JSON.stringify({
      type: "error",
      error: {
        type: "authentication_error",
        message: "invalid x-api-key",
      },
    });
    const parsed = parseProviderErrorBody(raw);
    expect(parsed.type).toBe("authentication_error");
    expect(parsed.rawMessage).toBe("invalid x-api-key");
  });

  it("safely parses flat error payload with root-level code", () => {
    const raw = JSON.stringify({
      code: "insufficient_quota",
      message: "quota exceeded",
    });
    const parsed = parseProviderErrorBody(raw);
    expect(parsed.code).toBe("insufficient_quota");
    expect(parsed.rawMessage).toBe("quota exceeded");
  });

  it("safely parses string error field", () => {
    const raw = JSON.stringify({ error: "rate limit exceeded" });
    const parsed = parseProviderErrorBody(raw);
    expect(parsed.rawMessage).toBe("rate limit exceeded");
  });

  it("safely handles non-JSON HTML error page (e.g. Cloudflare 502)", () => {
    const html = "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>";
    const parsed = parseProviderErrorBody(html);
    expect(parsed).toEqual({});
  });

  it("safely handles empty string or undefined-like inputs", () => {
    expect(parseProviderErrorBody("")).toEqual({});
    expect(parseProviderErrorBody("   ")).toEqual({});
    expect(parseProviderErrorBody("not valid json")).toEqual({});
  });
});

describe("AI Gateway user-facing error messages", () => {
  it("explains billing and quota need attention for 429 with credit_balance_exhausted without leaking secrets", () => {
    const message = gatewayMessageForStatus(429, {
      code: "credit_balance_exhausted",
      type: "insufficient_quota",
    });
    expect(message).toContain("billing");
    expect(message).toContain("quota");
    expect(message).not.toContain("sk-");
    expect(message).not.toContain("Authorization");
  });

  it("explains billing and quota need attention for HTTP 402", () => {
    const message = gatewayMessageForStatus(402);
    expect(message).toContain("billing");
    expect(message).toContain("quota");
  });

  it("gives standard rate limit message for genuine 429 rate limit", () => {
    const message = gatewayMessageForStatus(429, {
      code: "rate_limit_exceeded",
      type: "requests",
    });
    expect(message).toBe("Rate limit reached. Give it a few seconds and try again.");
  });

  it("gives operator message for 401 and 403 credentials failures", () => {
    expect(gatewayMessageForStatus(401)).toContain("rejected our credentials");
    expect(gatewayMessageForStatus(403)).toContain("rejected our credentials");
  });

  it("gives model unavailable message for 404", () => {
    expect(gatewayMessageForStatus(404)).toContain("model is unavailable");
  });

  it("gives service failed message for 5xx", () => {
    expect(gatewayMessageForStatus(500)).toBe(
      "The AI service failed to respond. Please try again.",
    );
    expect(gatewayMessageForStatus(503)).toBe(
      "The AI service failed to respond. Please try again.",
    );
  });
});

describe("GatewayError model", () => {
  it("preserves status, code, and errorType on GatewayError instance", () => {
    const err = new GatewayError("Quota exhausted", 429, {
      code: "credit_balance_exhausted",
      errorType: "insufficient_quota",
      rawMessage: "Provider details",
    });
    expect(err.status).toBe(429);
    expect(err.code).toBe("credit_balance_exhausted");
    expect(err.errorType).toBe("insufficient_quota");
    expect(err.rawMessage).toBe("Provider details");
  });
});

describe("Ingestion retry logic and provider error classification end-to-end", () => {
  it("OpenAI 429 with credit_balance_exhausted is mapped to permanent failure and not retried", () => {
    const parsedBody = parseProviderErrorBody(
      JSON.stringify({
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          param: null,
          code: "credit_balance_exhausted",
        },
      }),
    );
    const gatewayError = new GatewayError(gatewayMessageForStatus(429, parsedBody), 429, {
      code: parsedBody.code,
      errorType: parsedBody.type,
      rawMessage: parsedBody.rawMessage,
    });

    const classified = classifyError(gatewayError);
    expect(classified.code).toBe("CREDITS_EXHAUSTED");
    expect(classified.failureClass).toBe("PERMANENT");
    expect(isRetryable(classified, 1)).toBe(false);
    expect(isRetryable(classified, 3)).toBe(false);
    expect(classified.message).toContain("billing");
  });

  it("Genuine 429 rate limit is retryable with exponential backoff", () => {
    const parsedBody = parseProviderErrorBody(
      JSON.stringify({
        error: {
          message: "Rate limit reached for requests per minute",
          type: "requests",
          code: "rate_limit_exceeded",
        },
      }),
    );
    const gatewayError = new GatewayError(gatewayMessageForStatus(429, parsedBody), 429, {
      code: parsedBody.code,
      errorType: parsedBody.type,
    });

    const classified = classifyError(gatewayError);
    expect(classified.code).toBe("RATE_LIMITED");
    expect(classified.failureClass).toBe("RESOURCE_LIMIT");
    expect(isRetryable(classified, 1)).toBe(true);
    expect(isRetryable(classified, 2)).toBe(true);

    const backoff1 = backoffSeconds(1, classified.failureClass);
    const backoff2 = backoffSeconds(2, classified.failureClass);
    expect(backoff1).toBeGreaterThanOrEqual(30);
    expect(backoff2).toBeGreaterThan(backoff1);
  });

  it("Invalid credentials (401/403) is permanent and not retried", () => {
    const gatewayError = new GatewayError(gatewayMessageForStatus(401), 401, {
      code: "invalid_api_key",
    });
    const classified = classifyError(gatewayError);
    expect(classified.code).toBe("INVALID_CREDENTIALS");
    expect(classified.failureClass).toBe("PERMANENT");
    expect(isRetryable(classified, 1)).toBe(false);
  });

  it("Transient 503 is retryable with exponential backoff", () => {
    const gatewayError = new GatewayError(gatewayMessageForStatus(503), 503);
    const classified = classifyError(gatewayError);
    expect(classified.code).toBe("UPSTREAM_ERROR");
    expect(classified.failureClass).toBe("DEPENDENCY");
    expect(isRetryable(classified, 1)).toBe(true);
  });
});
