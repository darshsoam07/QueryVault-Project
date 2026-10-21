/** Disposable local Docker/Postgres only. Never reads .env or accepts a DB URL. */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const container = process.env.QV_DB_TEST_CONTAINER;
if (!container?.startsWith("queryvault-phase2-"))
  throw new Error("Set QV_DB_TEST_CONTAINER to a disposable queryvault-phase2-* Docker container.");
const inspection = JSON.parse(
  execFileSync("docker", ["inspect", container], { encoding: "utf8" }),
)[0];
assert.equal(inspection.HostConfig.NetworkMode, "none", "Test container must be network-isolated");
assert.ok(
  inspection.Mounts.every((mount) => mount.Type === "volume"),
  "Test container must have no host bind mounts",
);
const database = `audit_${Date.now()}`;
// docker run returns before Postgres finishes initialising its socket.
// Bound readiness polling to twenty attempts on this verified disposable target.
let ready = false;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    execFileSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], {
      stdio: "ignore",
      timeout: 2000,
    });
    ready = true;
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
assert.ok(ready, "Disposable Postgres did not become ready within the bounded startup wait");
execFileSync("docker", ["exec", container, "createdb", "-U", "postgres", database]);
let sqlOperations = 0;
function sql(statement) {
  sqlOperations++;
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-qAt",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
    ]);
    let output = "",
      error = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (error += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(error))));
    child.stdin.end(statement);
  });
}
const prelude = `
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE supabase_auth_admin; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth; CREATE SCHEMA storage;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth,storage,public TO anon,authenticated,service_role;
CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.objects TO authenticated,service_role;
CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array($1,'/') $$;
`;
const reports = [];
async function check(name, test) {
  const start = performance.now();
  await test();
  reports.push({ name, passed: true, durationMs: Math.round(performance.now() - start) });
  console.log(`PASS ${name}`);
}
const user = "11111111-1111-4111-8111-111111111111",
  foreign = "22222222-2222-4222-8222-222222222222";
const doc = (n) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;
const insert = (n, owner = user) =>
  `INSERT INTO public.documents(id,user_id,filename,byte_size,status,content_hash) VALUES('${doc(n)}','${owner}','fixture-${n}.txt',100,'uploaded',null);`;
try {
  await sql(prelude);
  for (const name of readdirSync("supabase/migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (name === "20260904000000_schedule_ingestion_worker.sql") continue;
    const source = readFileSync(`supabase/migrations/${name}`, "utf8").replace(
      /CREATE EXTENSION IF NOT EXISTS pg_(cron|net);/g,
      "",
    );
    await sql(source);
  }
  console.log(
    "Applied core migrations to real local Postgres/pgvector; Supabase Auth/Storage schemas are test scaffolding; cron/net/Vault migration not tested.",
  );
  const rpcCandidate = readFileSync(
    "supabase/migrations/20261022000000_restore_ingestion_claim_rpc.sql",
    "utf8",
  );
  const mutateIdentity =
    "public.mutate_ingestion_claim(uuid,text,integer,jsonb,jsonb,jsonb,integer)";
  await check(
    "repair migration is a verified no-op for matching functions and restores a missing function",
    async () => {
      const before = await sql(
        "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.claim_ingestion_jobs(text,text,integer,integer,uuid)'::regprocedure;",
      );
      const existing = await sql(
        `SELECT oid::text||':'||md5(prosrc)||':'||proacl::text FROM pg_proc WHERE oid='${mutateIdentity}'::regprocedure;`,
      );
      await sql(rpcCandidate);
      assert.equal(
        await sql(
          `SELECT oid::text||':'||md5(prosrc)||':'||proacl::text FROM pg_proc WHERE oid='${mutateIdentity}'::regprocedure;`,
        ),
        existing,
      );
      await assert.rejects(
        sql(
          `BEGIN; DROP FUNCTION ${mutateIdentity}; ALTER TABLE public.documents RENAME COLUMN parser_version TO fixture_missing_parser; ${rpcCandidate}`,
        ),
        /incompatible columns/,
      );
      await assert.rejects(
        sql(
          `BEGIN; DROP FUNCTION ${mutateIdentity}; CREATE FUNCTION public.mutate_ingestion_claim(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false'; ${rpcCandidate}`,
        ),
        /differs or has overloads/,
      );
      await sql(`DROP FUNCTION ${mutateIdentity};`);
      await assert.rejects(
        sql(`BEGIN; GRANT CREATE ON SCHEMA public TO authenticated; ${rpcCandidate}`),
        /untrusted CREATE/,
      );
      await sql(rpcCandidate);
      assert.equal(
        await sql(
          `SELECT proargnames::text FROM pg_proc WHERE oid='${mutateIdentity}'::regprocedure;`,
        ),
        "{job_id,claim_worker,claim_attempt,document_patch,chunk_rows,job_patch,prune_max_index}",
      );
      assert.equal(
        await sql(
          `SELECT proconfig::text FROM pg_proc WHERE oid='${mutateIdentity}'::regprocedure;`,
        ),
        '{"search_path=pg_catalog, public, pg_temp"}',
      );
      const restoredIdentity = await sql(
        `SELECT oid::text||':'||proacl::text FROM pg_proc WHERE oid='${mutateIdentity}'::regprocedure;`,
      );
      await sql(rpcCandidate);
      assert.equal(
        await sql(
          `SELECT oid::text||':'||proacl::text FROM pg_proc WHERE oid='${mutateIdentity}'::regprocedure;`,
        ),
        restoredIdentity,
      );
      assert.equal(
        await sql(
          "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.claim_ingestion_jobs(text,text,integer,integer,uuid)'::regprocedure;",
        ),
        before,
      );
      assert.equal(
        await sql(
          `SELECT pronargdefaults FROM pg_proc WHERE oid='${mutateIdentity}'::regprocedure;`,
        ),
        "4",
      );
      assert.equal(
        await sql(
          `SET ROLE service_role; SELECT public.mutate_ingestion_claim('${doc(999)}', 'fixture', 1);`,
        ),
        "f",
      );
      await assert.rejects(
        sql(`SET ROLE anon; SELECT public.mutate_ingestion_claim('${doc(999)}', 'fixture', 1);`),
        /permission denied/,
      );
      await assert.rejects(
        sql(
          `SET ROLE authenticated; SELECT public.mutate_ingestion_claim('${doc(999)}', 'fixture', 1);`,
        ),
        /permission denied/,
      );
      assert.equal(
        await sql(
          "SELECT count(*) FROM pg_class WHERE oid IN ('public.documents'::regclass,'public.ingestion_jobs'::regclass,'public.document_chunks'::regclass) AND relrowsecurity;",
        ),
        "3",
      );
    },
  );
  await check(
    "read-only hosted catalog diagnostics execute without invoking ingestion RPCs",
    async () => {
      await sql(
        readFileSync("docs/sql/ingestion_rpc_read_only_diagnostics.sql", "utf8").split(
          "-- Run this separate block",
        )[0],
      );
    },
  );
  await check(
    "restoration verification SQL is read-only and runs against the restored interface",
    async () => {
      await sql(readFileSync("docs/sql/verify_restored_ingestion_claim_rpc.sql", "utf8"));
    },
  );
  await sql(
    `INSERT INTO auth.users(id,email) VALUES('${user}','owner@example.test'),('${foreign}','other@example.test');`,
  );
  await check("atomic simultaneous upload admission", async () => {
    await sql("UPDATE public.ingestion_limits SET queued_per_user=1;");
    const results = await Promise.allSettled([
      sql(`BEGIN; ${insert(1)} SELECT pg_sleep(0.25); COMMIT;`),
      sql(insert(2)),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(await sql("SELECT count(*) FROM public.documents;"), "1");
    await sql(
      "DELETE FROM public.documents; UPDATE public.ingestion_limits SET queued_per_user=20;",
    );
  });
  await check("20 reservations and owner scoped duplicate constraint", async () => {
    await sql(Array.from({ length: 20 }, (_, i) => insert(i + 1)).join("\n"));
    await assert.rejects(sql(insert(21)), /admission limit/);
    await sql(insert(22, foreign));
    await sql(`UPDATE public.documents SET content_hash=repeat('a',64) WHERE id='${doc(1)}';`);
    await assert.rejects(
      sql(`UPDATE public.documents SET content_hash=repeat('a',64) WHERE id='${doc(2)}';`),
      /duplicate key/,
    );
  });
  await check(
    "overlapping workers share global capacity and do not duplicate live claims",
    async () => {
      await sql(
        `INSERT INTO public.ingestion_jobs(document_id,user_id) SELECT id,user_id FROM public.documents WHERE user_id='${user}';`,
      );
      const results = await Promise.all([
        sql("SELECT id FROM public.claim_ingestion_jobs('worker-a','test',5);"),
        sql("SELECT id FROM public.claim_ingestion_jobs('worker-b','test',5);"),
      ]);
      const ids = results.flatMap((value) => value.split("\n").filter(Boolean));
      assert.equal(ids.length, 3);
      assert.equal(new Set(ids).size, 3);
    },
  );
  const claim = JSON.parse(
    await sql(
      "SELECT row_to_json(j) FROM public.ingestion_jobs j WHERE status='running' ORDER BY id LIMIT 1;",
    ),
  );
  const mutate = (worker, attempt, patch = {}, rows = [], jobPatch = {}, prune = null) =>
    `SELECT public.mutate_ingestion_claim('${claim.id}','${worker}',${attempt},'${JSON.stringify(patch)}'::jsonb,'${JSON.stringify(rows)}'::jsonb,'${JSON.stringify(jobPatch)}'::jsonb,${prune ?? "NULL"});`;
  await check(
    "restoration preserves every existing fixture document, job and chunk row",
    async () => {
      const snapshot = ["documents", "ingestion_jobs", "document_chunks"]
        .map(
          (table) =>
            `SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text,'')) FROM public.${table} r`,
        )
        .join(" UNION ALL ");
      const before = await sql(snapshot);
      await sql(`DROP FUNCTION ${mutateIdentity};`);
      await sql(rpcCandidate);
      assert.equal(await sql(snapshot), before);
    },
  );
  await check("restored RPC persists first validation and atomic failure recording", async () => {
    assert.equal(
      await sql(
        `BEGIN; ${mutate(claim.locked_by, claim.attempt_count, { status: "validating", phase: "validating", progress: 10 })} SELECT status||':'||progress FROM public.documents WHERE id='${claim.document_id}'; ROLLBACK;`,
      ),
      "t\nvalidating:10",
    );
    assert.equal(
      await sql(
        `BEGIN; ${mutate(claim.locked_by, claim.attempt_count, { status: "failed", phase: "failed", failure_code: "FIXTURE_FAILURE" }, [], { status: "failed", error_code: "FIXTURE_FAILURE", locked_at: null, locked_by: null })} SELECT j.status||':'||d.status||':'||j.error_code FROM public.ingestion_jobs j JOIN public.documents d ON d.id=j.document_id WHERE j.id='${claim.id}'; ROLLBACK;`,
      ),
      "t\nfailed:failed:FIXTURE_FAILURE",
    );
  });
  await check(
    "PostgreSQL distinguishes missing function from missing column in a live RPC body",
    async () => {
      await assert.rejects(
        sql(
          `\\set VERBOSITY verbose\nBEGIN; DROP FUNCTION ${mutateIdentity}; ${mutate(claim.locked_by, claim.attempt_count, { phase: "validating" })} ROLLBACK;`,
        ),
        /42883/,
      );
      await assert.rejects(
        sql(
          `\\set VERBOSITY verbose\nBEGIN; ALTER TABLE public.documents RENAME COLUMN parser_version TO fixture_removed_parser_version; ${mutate(claim.locked_by, claim.attempt_count, { phase: "validating" })} ROLLBACK;`,
        ),
        /42703/,
      );
      assert.equal(
        await sql(`SELECT status FROM public.documents WHERE id='${claim.document_id}';`),
        "uploaded",
      );
    },
  );
  await check("expired lease recovery fences stale finalization", async () => {
    // Model termination immediately after claiming, before the first phase write.
    assert.equal(
      await sql(`SELECT status FROM public.documents WHERE id='${claim.document_id}';`),
      "uploaded",
    );
    await sql(
      `UPDATE public.ingestion_jobs SET locked_at=clock_timestamp()-interval '301 seconds', available_at='2000-01-01' WHERE id='${claim.id}';`,
    );
    assert.equal(
      await sql(mutate(claim.locked_by, claim.attempt_count, { phase: "indexing" })),
      "f",
    );
    await sql("SELECT id FROM public.claim_ingestion_jobs('replacement','test',1);");
    assert.equal(await sql(mutate(claim.locked_by, claim.attempt_count, { phase: "ready" })), "f");
    const current = JSON.parse(
      await sql(`SELECT row_to_json(j) FROM public.ingestion_jobs j WHERE id='${claim.id}';`),
    );
    assert.equal(current.locked_by, "replacement");
    assert.equal(current.attempt_count, claim.attempt_count + 1);
    assert.equal(
      await sql(`SELECT status FROM public.documents WHERE id='${claim.document_id}';`),
      "uploaded",
    );
    // An old process resuming after reclaim cannot renew or change document state.
    assert.equal(
      await sql(
        mutate(claim.locked_by, claim.attempt_count, {}, [], {
          locked_at: new Date().toISOString(),
        }),
      ),
      "f",
    );
    assert.equal(
      await sql(
        mutate(current.locked_by, current.attempt_count, {}, [], {
          locked_at: new Date().toISOString(),
        }),
      ),
      "t",
    );
    Object.assign(claim, current);
  });
  await check("fenced idempotent version replacement and complete READY publication", async () => {
    await sql(
      `UPDATE public.documents SET status='validating' WHERE id='${claim.document_id}'; UPDATE public.documents SET status='stored' WHERE id='${claim.document_id}'; UPDATE public.documents SET status='processing' WHERE id='${claim.document_id}';`,
    );
    const row = {
      id: doc(100),
      document_id: claim.document_id,
      user_id: user,
      content: "The notice period is 30 days.",
      page_number: 1,
      chunk_index: 0,
      token_estimate: 10,
      embedding: `[${Array.from({ length: 3072 }, () => 0.1).join(",")}]`,
      chunking_version: 3,
      embedding_model: "fixture",
    };
    assert.equal(await sql(mutate(claim.locked_by, claim.attempt_count, {}, [row])), "t");
    assert.equal(await sql(mutate(claim.locked_by, claim.attempt_count, {}, [row])), "t");
    row.id = doc(101);
    row.chunking_version = 4;
    assert.equal(await sql(mutate(claim.locked_by, claim.attempt_count, {}, [row])), "t");
    assert.equal(
      await sql(
        `SELECT count(*) FROM public.document_chunks WHERE document_id='${claim.document_id}';`,
      ),
      "1",
    );
    await assert.rejects(
      sql(
        mutate(
          claim.locked_by,
          claim.attempt_count,
          {
            status: "ready",
            chunking_version: 4,
            embedding_model: "fixture",
            embedding_dimension: 3072,
          },
          [],
          { status: "succeeded" },
          1,
        ),
      ),
      /Incomplete index/,
    );
    assert.equal(
      await sql(
        mutate(
          claim.locked_by,
          claim.attempt_count,
          {
            status: "ready",
            phase: "ready",
            chunking_version: 4,
            embedding_model: "fixture",
            embedding_dimension: 3072,
            chunk_count: 1,
          },
          [],
          { status: "succeeded", locked_at: null, locked_by: null },
          0,
        ),
      ),
      "t",
    );
  });
  await check("completed claim cannot publish READY twice or renew its lease", async () => {
    assert.equal(
      await sql(mutate(claim.locked_by, claim.attempt_count, { status: "ready", phase: "ready" })),
      "f",
    );
    assert.equal(
      await sql(
        mutate(claim.locked_by, claim.attempt_count, {}, [], {
          locked_at: new Date().toISOString(),
        }),
      ),
      "f",
    );
    assert.equal(
      await sql(
        `SELECT count(*) FROM public.document_chunks WHERE document_id='${claim.document_id}';`,
      ),
      "1",
    );
    assert.equal(
      await sql(`SELECT status FROM public.documents WHERE id='${claim.document_id}';`),
      "ready",
    );
  });
  await check(
    "dense/lexical queries enforce model, published version, ownership and empty scope before ranking",
    async () => {
      const vector = `[${Array.from({ length: 3072 }, () => 0.1).join(",")}]`;
      const query = (model, ids = "NULL") =>
        `SET ROLE authenticated; SET request.jwt.claim.sub='${user}'; SELECT count(*) FROM public.match_document_chunks_v2('${vector}'::halfvec,'${user}','${model}',60,${ids});`;
      assert.equal(await sql(query("fixture")), "1");
      assert.equal(await sql(query("different-model")), "0");
      assert.equal(await sql(query("fixture", "'{}'::uuid[]")), "0");
      assert.equal(await sql(query("fixture", `ARRAY['${doc(22)}']::uuid[]`)), "0");
      await sql(
        `UPDATE public.document_chunks SET chunking_version=999 WHERE document_id='${claim.document_id}';`,
      );
      assert.equal(await sql(query("fixture")), "0");
      assert.equal(
        await sql(
          `SET ROLE authenticated; SET request.jwt.claim.sub='${user}'; SELECT count(*) FROM public.lexical_document_chunks('notice','${user}',60,NULL);`,
        ),
        "0",
      );
      await sql(
        `UPDATE public.document_chunks SET chunking_version=4 WHERE document_id='${claim.document_id}';`,
      );
    },
  );
  await check("reindex admission is atomic and READY becomes non-searchable", async () => {
    await sql("UPDATE public.ingestion_limits SET queued_per_user=1;");
    await assert.rejects(
      sql(
        `INSERT INTO public.ingestion_jobs(document_id,user_id,kind) VALUES('${claim.document_id}','${user}','reindex');`,
      ),
      /admission limit/,
    );
    await sql("UPDATE public.ingestion_limits SET queued_per_user=30;");
    await sql(
      `INSERT INTO public.ingestion_jobs(document_id,user_id,kind) VALUES('${claim.document_id}','${user}','reindex');`,
    );
    assert.equal(
      await sql(`SELECT status FROM public.documents WHERE id='${claim.document_id}';`),
      "processing",
    );
  });
  await check("RLS and service-role retrieval do not broaden scope", async () => {
    assert.equal(
      await sql(
        `SET ROLE authenticated; SET request.jwt.claim.sub='${foreign}'; SELECT count(*) FROM public.documents WHERE user_id='${user}';`,
      ),
      "0",
    );
    assert.equal(
      await sql(
        `SET ROLE authenticated; SET request.jwt.claim.sub='${foreign}'; SELECT count(*) FROM public.lexical_document_chunks('notice','${user}',60,NULL);`,
      ),
      "0",
    );
    assert.equal(
      await sql(
        `SET ROLE service_role; SELECT count(*) FROM public.lexical_document_chunks('notice','${user}',60,NULL);`,
      ),
      "0",
    );
    await assert.rejects(
      sql("SET ROLE authenticated; SELECT * FROM public.claim_ingestion_jobs('browser');"),
      /permission denied/,
    );
  });
  await check("direct browser storage writes require an admitted reservation", async () => {
    await assert.rejects(
      sql(
        `SET ROLE authenticated; SET request.jwt.claim.sub='${foreign}'; INSERT INTO storage.objects(bucket_id,name) VALUES('documents','${foreign}/not-reserved.txt');`,
      ),
      /row-level security/,
    );
    assert.equal(
      await sql(
        `SET ROLE authenticated; SET request.jwt.claim.sub='${foreign}'; INSERT INTO storage.objects(bucket_id,name) VALUES('documents','${foreign}/${doc(22)}.txt'); SELECT count(*) FROM storage.objects;`,
      ),
      "1",
    );
  });
  await check("missing limits and null leases fail closed", async () => {
    await sql("BEGIN; DELETE FROM public.ingestion_limits; ROLLBACK;");
    const active = JSON.parse(
      await sql(
        "SELECT row_to_json(j) FROM public.ingestion_jobs j WHERE status='running' LIMIT 1;",
      ),
    );
    await sql(`UPDATE public.ingestion_jobs SET locked_at=NULL WHERE id='${active.id}';`);
    assert.equal(
      await sql(
        `SELECT public.mutate_ingestion_claim('${active.id}','${active.locked_by}',${active.attempt_count},'{}');`,
      ),
      "f",
    );
    await assert.rejects(
      sql("BEGIN; DELETE FROM public.ingestion_limits;" + insert(23)),
      /not configured/,
    );
    await assert.rejects(
      sql("SELECT * FROM public.claim_ingestion_jobs('invalid-duration','test',1,1);"),
      /300 seconds/,
    );
  });
  await check("lease expiry while waiting for a document lock cannot publish", async () => {
    const active = JSON.parse(
      await sql(
        "SELECT row_to_json(j) FROM public.ingestion_jobs j WHERE status='running' AND locked_at IS NOT NULL LIMIT 1;",
      ),
    );
    await sql(
      `UPDATE public.ingestion_jobs SET locked_at=clock_timestamp()-interval '299 seconds' WHERE id='${active.id}';`,
    );
    const blocker = sql(
      `SET application_name='phase2-lease-blocker'; BEGIN; UPDATE public.documents SET progress=0 WHERE id='${active.document_id}'; SELECT pg_sleep(2); COMMIT;`,
    );
    let ready = false;
    for (let i = 0; i < 10; i++) {
      if (
        (await sql(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name='phase2-lease-blocker' AND wait_event='PgSleep';",
        )) === "1"
      ) {
        ready = true;
        break;
      }
    }
    assert.ok(ready, "Lock holder must be active before testing expiration");
    const started = performance.now();
    const result = await sql(
      `SELECT public.mutate_ingestion_claim('${active.id}','${active.locked_by}',${active.attempt_count},'{"phase":"indexing"}');`,
    );
    await blocker;
    assert.ok(
      performance.now() - started >= 1000,
      "Mutation must actually wait on the held document lock",
    );
    assert.equal(result, "f");
  });
  await check("crash recovery stops after the configured attempt budget", async () => {
    const active = JSON.parse(
      await sql(
        "SELECT row_to_json(j) FROM public.ingestion_jobs j WHERE status='running' LIMIT 1;",
      ),
    );
    await sql(
      `UPDATE public.ingestion_jobs SET attempt_count=max_attempts,locked_at=NULL WHERE id='${active.id}';`,
    );
    await sql("SELECT id FROM public.claim_ingestion_jobs('recovery-limit','test',1);");
    assert.equal(
      await sql(
        `SELECT status||':'||error_code FROM public.ingestion_jobs WHERE id='${active.id}';`,
      ),
      "failed:ATTEMPTS_EXHAUSTED",
    );
    assert.equal(
      await sql(`SELECT status FROM public.documents WHERE id='${active.document_id}';`),
      "failed",
    );
  });
  await check("deleting a claimed document prevents any new chunks", async () => {
    await sql("UPDATE public.ingestion_limits SET global_workers=5;");
    const fresh = JSON.parse(
      await sql(
        "SELECT row_to_json(j) FROM public.claim_ingestion_jobs('delete-worker','test',1) j LIMIT 1;",
      ),
    );
    await sql(`DELETE FROM public.documents WHERE id='${fresh.document_id}';`);
    assert.equal(
      await sql(
        `SELECT public.mutate_ingestion_claim('${fresh.id}','delete-worker',${fresh.attempt_count},'{"status":"ready"}');`,
      ),
      "f",
    );
    assert.equal(
      await sql(
        `SELECT count(*) FROM public.document_chunks WHERE document_id='${fresh.document_id}';`,
      ),
      "0",
    );
  });
  writeFileSync(
    ".verification/phase2-database.json",
    JSON.stringify(
      {
        database,
        postgres: "local Docker pgvector pg17",
        serverVersion: await sql("SHOW server_version;"),
        vectorVersion: await sql("SELECT extversion FROM pg_extension WHERE extname='vector';"),
        imageId: inspection.Image,
        sqlOperations,
        image: inspection.Config.Image,
        schedulerVerified: false,
        authStorageHttpVerified: false,
        reports,
      },
      null,
      2,
    ),
  );
  console.log(`${reports.length} database integration checks passed.`);
} finally {
  execFileSync("docker", ["exec", container, "dropdb", "-U", "postgres", database]);
}
