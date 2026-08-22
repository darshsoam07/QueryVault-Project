/**
 * Database isolation invariants, asserted against the migrations themselves.
 *
 * The multi-tenancy guarantee in this app is not enforced by application code —
 * it is enforced by Row Level Security. That makes the SQL the security
 * boundary, and an untested security boundary is an assumption. These tests
 * parse `supabase/migrations/*.sql` and fail the build if a future migration
 * weakens one of the properties the design depends on.
 *
 * What this can and cannot tell you, stated plainly: this is static analysis of
 * the schema we ship, not a live-database integration test. It proves the
 * migrations declare the right policies; it does not prove a running Postgres
 * enforces them, which would need a real instance and real users. It is the
 * layer that catches the realistic regression — someone adds a table and
 * forgets `ENABLE ROW LEVEL SECURITY`, or relaxes a policy to `USING (true)`
 * while debugging and never puts it back.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** All migrations concatenated in apply order — the schema as Postgres will see it. */
const sql = migrationFiles.map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8")).join("\n");

/** Strip `--` line comments so prose about policies can't satisfy a regex. */
const code = sql.replace(/--[^\n]*/g, "");

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function createdTables(): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi)) {
    names.add(m[1]!.toLowerCase());
  }
  return [...names].sort();
}

function rlsEnabledTables(): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(
    /alter\s+table\s+public\.(\w+)\s+enable\s+row\s+level\s+security/gi,
  )) {
    names.add(m[1]!.toLowerCase());
  }
  return names;
}

type Policy = { name: string; table: string; schema: string; body: string };

function policies(): Policy[] {
  const found: Policy[] = [];
  const re = /create\s+policy\s+"?([\w]+)"?\s+on\s+(\w+)\.(\w+)([\s\S]*?);/gi;
  for (const m of code.matchAll(re)) {
    found.push({
      name: m[1]!,
      schema: m[2]!.toLowerCase(),
      table: m[3]!.toLowerCase(),
      body: m[4]!.replace(/\s+/g, " ").trim(),
    });
  }
  return found;
}

type Fn = { name: string; body: string; definer: boolean };

/**
 * Function bodies, keyed by name. A migration may replace an earlier definition,
 * so later definitions win — the invariant must hold for the *final* schema, not
 * for a version that was superseded three migrations ago.
 *
 * Bodies are delimited by their own dollar-quote tag rather than a hardcoded
 * `$$`: this schema uses both `$$` and `$function$`, and pairing every body with
 * `$$` makes a `$function$` body swallow the functions that follow it.
 */
function functions(): Map<string, Fn> {
  const map = new Map<string, Fn>();
  const start = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi;

  for (const m of code.matchAll(start)) {
    const name = m[1]!.toLowerCase();
    const rest = code.slice(m.index);

    const tagMatch = /\bas\s+(\$\w*\$)/i.exec(rest);
    if (!tagMatch) continue;
    const tag = tagMatch[1]!;
    const bodyStart = tagMatch.index + tagMatch[0].length;
    const bodyEnd = rest.indexOf(tag, bodyStart);
    if (bodyEnd === -1) continue;

    const body = rest.slice(0, bodyEnd + tag.length);
    map.set(name, { name, body, definer: /security\s+definer/i.test(body) });
  }
  return map;
}

const TABLES = createdTables();
const RLS = rlsEnabledTables();
const POLICIES = policies();
const FUNCTIONS = functions();

/**
 * Tables holding per-tenant rows. Each must have a `user_id` (or, for `profiles`,
 * an `id`) compared against `auth.uid()` in every policy that touches it.
 */
const USER_DATA_TABLES = [
  "documents",
  "document_chunks",
  "threads",
  "messages",
  "profiles",
  "ingestion_jobs",
  "telemetry_events",
  "query_traces",
  "rate_limit_events",
  "user_roles",
];

// ---------------------------------------------------------------------------
// Row Level Security
// ---------------------------------------------------------------------------

describe("row level security", () => {
  it("finds the migrations (guards against a silently empty test run)", () => {
    // Without this, a bad path would make every test below pass vacuously.
    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(TABLES.length).toBeGreaterThan(0);
    expect(POLICIES.length).toBeGreaterThan(0);
    expect(FUNCTIONS.size).toBeGreaterThan(0);
  });

  it("enables RLS on every table in the public schema", () => {
    const unprotected = TABLES.filter((t) => !RLS.has(t));
    // Reported as a list rather than one-at-a-time so a failure names every
    // offending table at once.
    expect(unprotected).toEqual([]);
  });

  it("covers the tables the application actually uses", () => {
    // Pins the expected set, so dropping a table is a deliberate act that
    // updates this list rather than something the suite quietly tolerates.
    expect(TABLES).toEqual([
      "document_chunks",
      "documents",
      "ingestion_jobs",
      "messages",
      "profiles",
      "query_traces",
      "rate_limit_events",
      "telemetry_events",
      "threads",
      "user_roles",
      "worker_credentials",
    ]);
  });
});

// ---------------------------------------------------------------------------
// User isolation
// ---------------------------------------------------------------------------

describe("user isolation", () => {
  it.each(USER_DATA_TABLES)("every policy on %s is scoped by auth.uid()", (table) => {
    const forTable = POLICIES.filter((p) => p.schema === "public" && p.table === table);
    expect(forTable.length).toBeGreaterThan(0);

    for (const policy of forTable) {
      expect(policy.body, `${policy.name} must reference auth.uid()`).toMatch(/auth\.uid\(\)/i);
    }
  });

  it("has no policy that grants unconditional access to user data", () => {
    const permissive = POLICIES.filter(
      (p) => USER_DATA_TABLES.includes(p.table) && /using\s*\(\s*true\s*\)/i.test(p.body),
    ).map((p) => `${p.table}.${p.name}`);

    // `USING (true)` on a tenant table makes RLS a no-op while leaving
    // `relrowsecurity = true`, so it looks protected in every dashboard.
    expect(permissive).toEqual([]);
  });

  it("grants no policy to the anonymous or public role", () => {
    const anonymous = POLICIES.filter((p) => /\bto\s+(anon|public)\b/i.test(p.body)).map(
      (p) => `${p.table}.${p.name}`,
    );
    expect(anonymous).toEqual([]);
  });

  it("targets authenticated callers explicitly on every policy", () => {
    const untargeted = POLICIES.filter((p) => !/\bto\s+authenticated\b/i.test(p.body)).map(
      (p) => `${p.table}.${p.name}`,
    );
    // A policy with no TO clause applies to PUBLIC, which includes anon.
    expect(untargeted).toEqual([]);
  });

  it("leaves worker_credentials with RLS on and no policy at all", () => {
    // Deliberate: RLS enabled with zero policies denies every non-superuser
    // read. Only the service role, which bypasses RLS, can see worker secrets.
    expect(RLS.has("worker_credentials")).toBe(true);
    expect(POLICIES.filter((p) => p.table === "worker_credentials")).toEqual([]);
    expect(code).toMatch(/revoke\s+all\s+on\s+public\.worker_credentials\s+from[^;]*anon/i);
  });

  it("keeps chunk and document writes off the client entirely", () => {
    // Ingestion is server-authoritative: the browser may read its own rows but
    // cannot forge a document row or inject a chunk into the retrieval corpus.
    expect(code).toMatch(
      /revoke\s+insert,\s*update\s+on\s+public\.documents\s+from\s+authenticated/i,
    );
    expect(code).toMatch(
      /revoke\s+insert,\s*update,\s*delete\s+on\s+public\.document_chunks\s+from\s+authenticated/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Retrieval functions — the RAG isolation boundary
// ---------------------------------------------------------------------------

describe("retrieval functions", () => {
  it.each(["match_document_chunks", "lexical_document_chunks"])(
    "%s independently constrains results to the calling user",
    (name) => {
      const fn = FUNCTIONS.get(name);
      expect(fn, `${name} should exist in the migrations`).toBeDefined();

      // Belt and braces. RLS already filters these queries, but the function
      // takes a user id as an argument; if the application ever passed the
      // wrong one, these predicates make the query return nothing rather than
      // another tenant's chunks. Enforcement is a WHERE clause, not a raised
      // exception — the caller sees an empty result set, not an error.
      expect(fn!.body).toMatch(/auth\.uid\(\)\s*=\s*requesting_user_id/i);
      expect(fn!.body).toMatch(/requesting_user_id\s+is\s+not\s+null/i);
      // Both the chunk and its parent document must belong to the caller, so a
      // chunk can never be reached through someone else's document row.
      expect(fn!.body).toMatch(/c\.user_id\s*=\s*requesting_user_id/i);
      expect(fn!.body).toMatch(/d\.user_id\s*=\s*requesting_user_id/i);
    },
  );

  it.each(["match_document_chunks", "lexical_document_chunks"])(
    "%s runs as the invoker, so RLS still applies",
    (name) => {
      const fn = FUNCTIONS.get(name)!;
      // SECURITY DEFINER here would run the retrieval query as the function
      // owner and bypass RLS on document_chunks — every tenant would share
      // one corpus.
      expect(fn.definer).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// SECURITY DEFINER hardening
// ---------------------------------------------------------------------------

describe("SECURITY DEFINER functions", () => {
  const definers = [...FUNCTIONS.values()].filter((f) => f.definer);

  it("exist, so the assertions below are not vacuous", () => {
    expect(definers.length).toBeGreaterThan(0);
  });

  it("pin search_path on every one", () => {
    const unpinned = definers
      .filter((f) => !/set\s+search_path\s*=/i.test(f.body))
      .map((f) => f.name);
    // An unpinned search_path on a DEFINER function is a privilege-escalation
    // vector: a caller who can create objects in an earlier schema can shadow
    // a referenced name and have it executed as the function owner.
    expect(unpinned).toEqual([]);
  });

  it("revoke execute from anon on every one", () => {
    const exposed = definers
      .filter(
        (f) =>
          !new RegExp(`revoke[^;]*on\\s+function\\s+public\\.${f.name}\\b[^;]*anon`, "i").test(
            code,
          ),
      )
      .map((f) => f.name);
    expect(exposed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe("document storage", () => {
  it("provisions the bucket as private, by migration rather than by hand", () => {
    const insert = /insert\s+into\s+storage\.buckets[\s\S]*?;/i.exec(code)?.[0] ?? "";
    expect(insert).toContain("'documents'");
    expect(insert).toMatch(/false/);
    // A re-run must not be able to flip an existing bucket public.
    expect(insert).toMatch(/on\s+conflict[\s\S]*set\s+public\s*=\s*false/i);
  });

  it("keeps the bucket out of any code path that would make it public", () => {
    expect(code).not.toMatch(/storage\.buckets[\s\S]{0,200}public\s*=\s*true/i);
  });

  it("scopes every storage policy to the owner's path prefix", () => {
    const storagePolicies = POLICIES.filter((p) => p.schema === "storage");
    expect(storagePolicies.length).toBeGreaterThan(0);

    for (const policy of storagePolicies) {
      expect(policy.body).toMatch(/bucket_id\s*=\s*'documents'/i);
      // The first path segment *is* the authorization boundary, which is why
      // uploads are written to `<user-id>/<file>`.
      expect(policy.body).toMatch(
        /storage\.foldername\(name\)\)\[1\]\s*=\s*\(?auth\.uid\(\)\)?::text/i,
      );
    }
  });
});
