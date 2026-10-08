/**
 * Server-only constant-time comparison for shared secrets.
 *
 * This module compares two secret strings without leaking information about
 * them through timing. It is named `*.server.ts` on purpose: the project's
 * server-only convention (enforced by ESLint `no-restricted-imports` for
 * client-reachable code, and by TanStack Start which refuses to bundle
 * `*.server` modules into the client build) keeps this helper — and the
 * `node:crypto` import — out of browser bundles.
 *
 * Why hash-then-compare: `timingSafeEqual` throws when its two buffers have
 * different lengths, and branching on `a.length !== b.length` leaks the
 * expected secret's length to anyone able to time the request. Hashing both
 * inputs with SHA-256 first turns every input into a fixed 32-byte digest, so
 * there is no length-dependent branch before the constant-time comparison.
 *
 * Fail-closed semantics: any missing or empty input returns `false` — never
 * throws, never logs either input.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function constantTimeCompare(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (!provided || !expected) return false;

  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}
