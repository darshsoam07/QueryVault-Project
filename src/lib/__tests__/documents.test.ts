/**
 * Document lifecycle: deletion, and the ownership rules that make it safe.
 *
 * Upload validation, the failure taxonomy and chunk idempotency are covered in
 * `ingestion.test.ts` and `security.test.ts`. This file covers what those do
 * not: removal, and the invariant that keeps removal from becoming a
 * cross-tenant operation.
 *
 * Two kinds of test live here, and the difference matters:
 *
 *   - Behavioural tests over `documents.policy.ts`, which is pure and can be
 *     called directly.
 *   - Source-level invariant tests over `documents.functions.ts`. Those server
 *     functions are only reachable through TanStack's `createServerFn`
 *     middleware chain, so calling the handler in isolation would mean
 *     reconstructing the framework's context — a test of the mock, not the
 *     code. Instead these assert the property that actually goes wrong in
 *     practice: an admin-client query that forgets its ownership filter.
 *     That is static analysis. It catches a dropped `.eq("user_id", userId)`;
 *     it does not prove the running query returns the right rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTIVE_STATES,
  DOCUMENT_STATES,
  canTransition,
  isOwnerScopedPath,
  ownerScopedPath,
  type DocumentState,
} from "@/lib/documents.policy";

const source = readFileSync(join(process.cwd(), "src", "lib", "documents.functions.ts"), "utf8");

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";

// ---------------------------------------------------------------------------
// Deletion as a state transition
// ---------------------------------------------------------------------------

describe("document deletion — state machine", () => {
  it("can be started from every non-deleting state", () => {
    // Deletion must never be blocked by the state a document happens to be in.
    // A document stuck mid-ingestion is exactly the one a user wants to remove.
    const startable = DOCUMENT_STATES.filter((s) => s !== "deleting");
    for (const from of startable) {
      expect(canTransition(from, "deleting"), `${from} -> deleting`).toBe(true);
    }
  });

  it("is terminal — nothing transitions out of deleting", () => {
    // This is what makes the delete safe to retry: a half-finished delete
    // cannot be resurrected into `ready` by a worker that was mid-flight.
    for (const to of DOCUMENT_STATES.filter((s) => s !== "deleting")) {
      expect(canTransition("deleting", to), `deleting -> ${to}`).toBe(false);
    }
  });

  it("allows deleting -> deleting, so a retried delete is not rejected", () => {
    // Self-transitions are permitted deliberately. The delete handler skips the
    // status write when the document is already `deleting`, and a client that
    // retries after a network failure must not get a state-machine error.
    expect(canTransition("deleting", "deleting")).toBe(true);
  });

  it("does not treat deleting as active ingestion work", () => {
    // If `deleting` were active, the worker would keep picking the document up.
    expect(ACTIVE_STATES).not.toContain("deleting" as DocumentState);
  });
});

// ---------------------------------------------------------------------------
// Storage ownership
// ---------------------------------------------------------------------------

describe("document deletion — storage path ownership", () => {
  it("derives the object path from the owner, not from client input", () => {
    // The delete falls back to this when `storage_path` is null. Deriving the
    // path means a forged column value cannot redirect the delete elsewhere.
    expect(ownerScopedPath(USER_A, DOC)).toBe(`${USER_A}/${DOC}.pdf`);
  });

  it("rejects a path belonging to another user", () => {
    expect(isOwnerScopedPath(ownerScopedPath(USER_A, DOC), USER_A)).toBe(true);
    expect(isOwnerScopedPath(ownerScopedPath(USER_B, DOC), USER_A)).toBe(false);
  });

  it.each([
    ["parent traversal", `../${USER_B}/${DOC}.pdf`],
    ["embedded traversal", `${USER_A}/../${USER_B}/${DOC}.pdf`],
    ["prefix collision", `${USER_A}extra/${DOC}.pdf`],
    ["absolute path", `/${USER_A}/${DOC}.pdf`],
    ["bare filename", `${DOC}.pdf`],
    ["empty", ""],
  ])("rejects %s", (_label, path) => {
    expect(isOwnerScopedPath(path, USER_A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ownership filters on the RLS-bypassing client
// ---------------------------------------------------------------------------

/** Every `supabaseAdmin.from(...)` chain in the server functions, one per match. */
function adminChains(): string[] {
  const chains: string[] = [];
  for (const m of source.matchAll(/supabaseAdmin\s*\n?\s*\.from\([\s\S]*?;/g)) {
    chains.push(m[0].replace(/\s+/g, " "));
  }
  return chains;
}

describe("admin client is always ownership-scoped", () => {
  const chains = adminChains();

  it("finds admin queries at all (guards against a vacuous pass)", () => {
    expect(chains.length).toBeGreaterThan(0);
  });

  it("scopes every read, update and delete by the caller", () => {
    // `supabaseAdmin` uses the service role key and therefore bypasses RLS
    // completely. For these queries the ownership filter in application code is
    // not defence in depth — it is the *only* thing standing between a user and
    // someone else's rows. A dropped `.eq("user_id", userId)` here is a
    // cross-tenant write with no database-level backstop.
    const unscoped = chains.filter((chain) => {
      if (/\.insert\(/.test(chain)) return false; // handled separately below
      const byUser = /\.eq\("user_id",\s*userId\)/.test(chain);
      // The ingestion_jobs cancel is keyed by document_id, which was itself
      // authorized against user_id immediately beforehand.
      const byDocument = /\.eq\("document_id",\s*data\.documentId\)/.test(chain);
      return !byUser && !byDocument;
    });

    expect(unscoped).toEqual([]);
  });

  it("stamps the owner on every insert", () => {
    // An insert has no existing row to filter, so ownership has to be written
    // into the payload. Omitting it would create an unowned — and by RLS,
    // unreachable — row.
    const inserts = chains.filter((chain) => /\.insert\(/.test(chain));
    expect(inserts.length).toBeGreaterThan(0);
    for (const chain of inserts) {
      expect(chain).toMatch(/user_id:\s*userId/);
    }
  });

  it("never widens a document update beyond a single id", () => {
    const updates = chains.filter((c) => /\.from\("documents"\)/.test(c) && /\.update\(/.test(c));
    expect(updates.length).toBeGreaterThan(0);
    for (const chain of updates) {
      expect(chain).toMatch(/\.eq\("id",\s*data\.documentId\)/);
      expect(chain).toMatch(/\.eq\("user_id",\s*userId\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// Deletion ordering and failure handling
// ---------------------------------------------------------------------------

describe("deleteDocument ordering", () => {
  /** The body of the delete handler, sliced out of the module source. */
  const handler = source.slice(source.indexOf("export const deleteDocument"));

  function orderOf(pattern: RegExp): number {
    const index = handler.search(pattern);
    expect(index, `expected to find ${pattern}`).toBeGreaterThan(-1);
    return index;
  }

  it("authorizes ownership before touching anything", () => {
    const authorize = orderOf(/\.from\("documents"\)\s*\.select\(/);
    const notFound = orderOf(/DOCUMENT_NOT_FOUND/);
    const firstMutation = orderOf(/supabaseAdmin/);

    expect(authorize).toBeLessThan(firstMutation);
    expect(notFound).toBeLessThan(firstMutation);
  });

  it("cancels the in-flight job before deleting its chunks", () => {
    // Reverse this and a running worker can write chunks back after the delete
    // has removed them, leaving orphaned vectors in the retrieval corpus.
    expect(orderOf(/\.from\("ingestion_jobs"\)/)).toBeLessThan(
      orderOf(/\.from\("document_chunks"\)\s*\.delete\(/),
    );
  });

  it("removes chunks and the stored object before the metadata row", () => {
    // The row is the only handle on the chunks and the storage path. Deleting it
    // first would make a mid-way failure unrecoverable — the data would remain
    // but nothing would reference it.
    const chunks = orderOf(/\.from\("document_chunks"\)\s*\.delete\(/);
    const storage = orderOf(/storage\.from\("documents"\)\.remove\(/);
    const row = orderOf(/\.from\("documents"\)\s*\.delete\(/);

    expect(chunks).toBeLessThan(row);
    expect(storage).toBeLessThan(row);
  });

  it("marks the document deleting first, so a retry resumes rather than restarts", () => {
    expect(orderOf(/status:\s*"deleting"/)).toBeLessThan(
      orderOf(/\.from\("document_chunks"\)\s*\.delete\(/),
    );
  });

  it("reports failures as structured codes, never raw database text", () => {
    // Each failure path must throw an ApiError. Returning `{ ok: true }` after a
    // failed step would report success while leaving data behind.
    const throws = handler.match(/throw new ApiError\("(\w+)"/g) ?? [];
    expect(throws.length).toBeGreaterThanOrEqual(4);
    expect(handler).toContain('throw new ApiError("DOCUMENT_NOT_FOUND"');

    // No interpolation of a Postgres/PostgREST error into a user-facing string.
    expect(handler).not.toMatch(/ApiError\([^)]*\$\{[^}]*error[^}]*\}/);
  });

  it("logs failures without the document's contents", () => {
    const logs = handler.match(/logEvent\([\s\S]*?\);/g) ?? [];
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      expect(log).not.toMatch(/content|chunk_text|snippet/i);
    }
  });
});
