/**
 * Constant-time shared-secret comparison.
 *
 * The worker drain endpoint and the deep health probe share one authentication
 * secret, so they must share one comparison routine. A bespoke comparison with
 * an early length return leaks the secret's length; a plain `===` comparison
 * leaks byte-prefix information through timing. The shared helper hashes both
 * inputs to fixed-length SHA-256 digests before `timingSafeEqual`, so there is
 * no length-dependent branch, and it fails closed (false) on any missing or
 * empty input without throwing or logging.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { constantTimeCompare } from "@/lib/constant-time-compare.server";

describe("constantTimeCompare", () => {
  it("returns true for equal values", () => {
    expect(
      constantTimeCompare("correct-horse-battery-staple", "correct-horse-battery-staple"),
    ).toBe(true);
  });

  it("returns false for different values of equal length", () => {
    expect(constantTimeCompare("secret-aaaa", "secret-aaab")).toBe(false);
  });

  it("returns false for different values of different lengths", () => {
    expect(constantTimeCompare("short", "a-much-longer-secret-value")).toBe(false);
    expect(constantTimeCompare("a-much-longer-secret-value", "short")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(constantTimeCompare("", "non-empty-secret")).toBe(false);
    expect(constantTimeCompare("non-empty-secret", "")).toBe(false);
    expect(constantTimeCompare("", "")).toBe(false);
  });

  it("returns false for missing input without throwing", () => {
    expect(constantTimeCompare(undefined, "secret")).toBe(false);
    expect(constantTimeCompare("secret", undefined)).toBe(false);
    expect(constantTimeCompare(null, "secret")).toBe(false);
    expect(constantTimeCompare("secret", null)).toBe(false);
    expect(constantTimeCompare(undefined, undefined)).toBe(false);
    expect(constantTimeCompare(null, null)).toBe(false);
  });

  it("handles unicode input correctly", () => {
    const secret = "sëcret-🔑-with-unicode-✓";
    expect(constantTimeCompare(secret, secret)).toBe(true);
    expect(constantTimeCompare(secret, "sëcret-🔑-with-unicode-✗")).toBe(false);
    expect(constantTimeCompare(secret, "secret-with-unicode")).toBe(false);
  });

  it("is symmetric", () => {
    expect(constantTimeCompare("alpha", "beta")).toBe(constantTimeCompare("beta", "alpha"));
  });
});

/* -------------------------------------------------------------------------- */
/* Both authenticated endpoints must use the shared helper.                   */
/* -------------------------------------------------------------------------- */

const routesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "routes",
  "api",
  "public",
);

function readRoute(name: string): string {
  return readFileSync(join(routesDir, name), "utf8");
}

describe("secret comparison in API routes", () => {
  it("worker-drain uses the shared helper", () => {
    const source = readRoute("worker-drain.ts");
    expect(source).toContain("@/lib/constant-time-compare.server");
    expect(source).toContain("constantTimeCompare(");
    expect(source).not.toContain("function timingSafeEqual");
    expect(source).not.toContain("charCodeAt");
  });

  it("deep health probe uses the shared helper instead of `===`", () => {
    const source = readRoute("health.ts");
    expect(source).toContain("@/lib/constant-time-compare.server");
    expect(source).toContain("constantTimeCompare(");
    expect(source).not.toMatch(/===\s*secret/);
    expect(source).not.toMatch(/secret\s*===/);
    expect(source).not.toContain("timingSafeEqual");
  });
});
