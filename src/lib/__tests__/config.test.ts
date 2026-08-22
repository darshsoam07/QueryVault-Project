/**
 * Configuration validation.
 *
 * These tests exist because of a live production failure that was misdiagnosed
 * twice: every request answering `401 {"message":"Invalid API key"}`. The cause
 * was never the auth code — it was public configuration that never reached the
 * build. `VITE_*` values are inlined at build time, so a build without them
 * produces an artifact that cannot work and cannot be fixed at deploy time.
 *
 * The assertions below are therefore mostly about the *detection* direction:
 * each malformed configuration must be caught, and — equally important — a
 * correct configuration must not be flagged, because a guard that cries wolf
 * gets disabled.
 *
 * One assertion is a security invariant rather than a behaviour: no finding may
 * ever contain a configuration *value*. These messages reach stdout, container
 * logs and log aggregators.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertBootConfig, collectBootFindings } from "@/lib/config/boot.server";
import {
  isPlaceholder,
  projectRefFromUrl,
  readLegacyKeyClaims,
  validateSupabaseConfig,
} from "@/lib/config/validate";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REF = "fultpxfredyqvcrwmcyx";
const OTHER_REF = "someotherprojectref1";

/** A legacy Supabase API key: unsigned here, since only the claims are read. */
function legacyKey(claims: { ref: string; role: string }): string {
  const b64 = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ...claims })}.sig`;
}

const VALID = {
  VITE_SUPABASE_URL: `https://${REF}.supabase.co`,
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_9Ktz4mQ1pL7vB2nR6sW0dA",
  VITE_SUPABASE_PROJECT_ID: REF,
  SUPABASE_URL: `https://${REF}.supabase.co`,
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_9Ktz4mQ1pL7vB2nR6sW0dA",
  SUPABASE_PROJECT_ID: REF,
  SUPABASE_SERVICE_ROLE_KEY: legacyKey({ ref: REF, role: "service_role" }),
};

const codes = (
  input: Parameters<typeof validateSupabaseConfig>[0],
  tiers?: ("public" | "server")[],
) => validateSupabaseConfig(input, tiers).map((finding) => finding.code);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("isPlaceholder", () => {
  it.each([
    // Exactly the placeholders this repository ships.
    ["https://your-project-ref.supabase.co", ".env.example URL"],
    ["sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxx", ".env.example key"],
    ["your-project-ref", ".env.example project id"],
    ["https://ci-placeholder.supabase.co", "CI build URL"],
    ["sb_publishable_ci_placeholder", "CI build key"],
    ["ci-placeholder", "CI build project id"],
    ["", "empty"],
    ["   ", "whitespace"],
    ["<your-key-here>", "angle-bracket stand-in"],
    ["CHANGEME", "conventional"],
  ])("flags %s (%s)", (value) => {
    expect(isPlaceholder(value)).toBe(true);
  });

  it("does not flag a real publishable key or URL", () => {
    expect(isPlaceholder(VALID.VITE_SUPABASE_PUBLISHABLE_KEY)).toBe(false);
    expect(isPlaceholder(VALID.VITE_SUPABASE_URL)).toBe(false);
    expect(isPlaceholder(REF)).toBe(false);
  });
});

describe("projectRefFromUrl", () => {
  it("extracts the ref from a Supabase URL", () => {
    expect(projectRefFromUrl(`https://${REF}.supabase.co`)).toBe(REF);
  });

  it("returns null for a non-https or unparseable URL", () => {
    // http would send the key in cleartext; treated as malformed, not merely odd.
    expect(projectRefFromUrl(`http://${REF}.supabase.co`)).toBeNull();
    expect(projectRefFromUrl("not-a-url")).toBeNull();
    expect(projectRefFromUrl(undefined)).toBeNull();
  });
});

describe("readLegacyKeyClaims", () => {
  it("reads ref and role from a legacy JWT key", () => {
    expect(readLegacyKeyClaims(legacyKey({ ref: REF, role: "anon" }))).toMatchObject({
      ref: REF,
      role: "anon",
    });
  });

  it("returns null for a new-format opaque key", () => {
    expect(readLegacyKeyClaims("sb_publishable_9Ktz4mQ1pL7vB2nR6sW0dA")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateSupabaseConfig
// ---------------------------------------------------------------------------

describe("validateSupabaseConfig", () => {
  it("passes a correct configuration with no findings", () => {
    expect(validateSupabaseConfig(VALID)).toEqual([]);
  });

  it("accepts a new-format secret key for the service role", () => {
    expect(
      validateSupabaseConfig({ ...VALID, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_7Hq2xE9tK4mZ" }),
    ).toEqual([]);
  });

  it("reports a missing variable", () => {
    expect(codes({ ...VALID, VITE_SUPABASE_PUBLISHABLE_KEY: undefined })).toContain(
      "CONFIG_MISSING",
    );
  });

  it("reports a placeholder without also reporting derived mismatches", () => {
    // The whole point of suppressing downstream checks: a placeholder produces
    // one actionable finding, not a cascade that buries it.
    const findings = validateSupabaseConfig({
      ...VALID,
      VITE_SUPABASE_URL: "https://ci-placeholder.supabase.co",
      VITE_SUPABASE_PROJECT_ID: "ci-placeholder",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_ci_placeholder",
    });
    expect(findings.map((f) => f.code)).toEqual([
      "CONFIG_PLACEHOLDER",
      "CONFIG_PLACEHOLDER",
      "CONFIG_PLACEHOLDER",
    ]);
  });

  it("catches the CI placeholder build when only the public tier is checked", () => {
    // This is the exact configuration .github/workflows/ci.yml builds with, and
    // the artifact it produces must never be deployable unnoticed.
    expect(
      codes(
        {
          VITE_SUPABASE_URL: "https://ci-placeholder.supabase.co",
          VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_ci_placeholder",
          VITE_SUPABASE_PROJECT_ID: "ci-placeholder",
        },
        ["public"],
      ),
    ).toEqual(["CONFIG_PLACEHOLDER", "CONFIG_PLACEHOLDER", "CONFIG_PLACEHOLDER"]);
  });

  it("reports a URL that is not a parseable https Supabase URL", () => {
    expect(codes({ ...VALID, SUPABASE_URL: "postgres://localhost:5432" })).toContain(
      "CONFIG_URL_INVALID",
    );
  });

  it("reports a project id that disagrees with the URL", () => {
    expect(codes({ ...VALID, SUPABASE_PROJECT_ID: OTHER_REF })).toContain(
      "CONFIG_PROJECT_MISMATCH",
    );
  });

  it("reports a legacy key issued for a different project", () => {
    // The failure this produces at runtime is `401 Invalid API key` — identical
    // to no key at all, and impossible to tell apart from the browser.
    const findings = validateSupabaseConfig({
      ...VALID,
      SUPABASE_SERVICE_ROLE_KEY: legacyKey({ ref: OTHER_REF, role: "service_role" }),
    });
    expect(findings.map((f) => f.code)).toContain("CONFIG_PROJECT_MISMATCH");
    expect(findings[0]?.message).toContain(OTHER_REF);
  });

  it("names every variable involved in a project mismatch", () => {
    const finding = validateSupabaseConfig({ ...VALID, SUPABASE_PROJECT_ID: OTHER_REF }).find(
      (f) => f.code === "CONFIG_PROJECT_MISMATCH",
    );
    expect(finding?.variables).toContain("SUPABASE_PROJECT_ID");
    expect(finding?.variables).toContain("SUPABASE_URL");
  });

  it("rejects a publishable key handed to the service-role variable", () => {
    // Silently wrong otherwise: every server-authoritative write fails on RLS
    // with a permission error that looks like a policy bug.
    expect(
      codes({ ...VALID, SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_9Ktz4mQ1pL7vB2nR6sW0dA" }),
    ).toContain("CONFIG_KEY_ROLE_INVALID");
  });

  it("rejects an anon legacy key handed to the service-role variable", () => {
    expect(
      codes({ ...VALID, SUPABASE_SERVICE_ROLE_KEY: legacyKey({ ref: REF, role: "anon" }) }),
    ).toContain("CONFIG_KEY_ROLE_INVALID");
  });

  it("rejects a service-role key placed in a VITE_ variable", () => {
    // The worst mistake available here: VITE_ is inlined into the browser
    // bundle, so this publishes an RLS-bypassing credential to every visitor.
    const findings = validateSupabaseConfig({
      ...VALID,
      VITE_SUPABASE_PUBLISHABLE_KEY: legacyKey({ ref: REF, role: "service_role" }),
    });
    expect(findings.map((f) => f.code)).toContain("CONFIG_SECRET_IN_PUBLIC");
  });

  it("rejects a new-format secret key placed in a VITE_ variable", () => {
    expect(codes({ ...VALID, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_7Hq2xE9tK4mZ" })).toContain(
      "CONFIG_SECRET_IN_PUBLIC",
    );
  });

  it("reports a public/server mirror that has drifted", () => {
    expect(
      codes({ ...VALID, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_differentKeyEntirely00" }),
    ).toContain("CONFIG_MIRROR_MISMATCH");
  });

  it("does not check the public tier when only the server tier is requested", () => {
    // A correctly-built container has no VITE_* at runtime; demanding them would
    // fail a healthy deployment.
    const serverOnly = {
      SUPABASE_URL: VALID.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: VALID.SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_PROJECT_ID: VALID.SUPABASE_PROJECT_ID,
      SUPABASE_SERVICE_ROLE_KEY: VALID.SUPABASE_SERVICE_ROLE_KEY,
    };
    expect(validateSupabaseConfig(serverOnly, ["server"])).toEqual([]);
  });

  it("never puts a configuration value in a finding message", () => {
    // Security invariant. Findings are logged and, for the build guard, printed
    // to CI output. Names and project refs only.
    const secrets = [
      VALID.SUPABASE_SERVICE_ROLE_KEY,
      VALID.VITE_SUPABASE_PUBLISHABLE_KEY,
      "sb_secret_7Hq2xE9tK4mZ",
    ];
    const broken = [
      { ...VALID, SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_9Ktz4mQ1pL7vB2nR6sW0dA" },
      { ...VALID, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_7Hq2xE9tK4mZ" },
      { ...VALID, SUPABASE_PROJECT_ID: OTHER_REF },
      { ...VALID, VITE_SUPABASE_PUBLISHABLE_KEY: undefined },
      { SUPABASE_SERVICE_ROLE_KEY: legacyKey({ ref: OTHER_REF, role: "service_role" }) },
    ];

    for (const input of broken) {
      for (const finding of validateSupabaseConfig(input)) {
        for (const secret of secrets) {
          expect(finding.message).not.toContain(secret);
        }
        // Not even a fragment long enough to be useful.
        expect(finding.message).not.toMatch(/sb_(publishable|secret)_[A-Za-z0-9]{6,}/);
        expect(finding.message).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Boot validation
// ---------------------------------------------------------------------------

describe("collectBootFindings", () => {
  const serverEnv = {
    SUPABASE_URL: VALID.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: VALID.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_PROJECT_ID: VALID.SUPABASE_PROJECT_ID,
    SUPABASE_SERVICE_ROLE_KEY: VALID.SUPABASE_SERVICE_ROLE_KEY,
    OPENAI_API_KEY: "sk-test",
    INGESTION_WORKER_SECRET: "0".repeat(64),
  };

  it("is clean for a correctly configured server with no VITE_ values present", () => {
    expect(collectBootFindings(serverEnv)).toEqual([]);
  });

  it("warns rather than fails when no AI provider key is set", () => {
    // The AI boundary already fails closed with a structured NOT_CONFIGURED, and
    // auth, uploads and the UI still work. Refusing to boot would be worse.
    const findings = collectBootFindings({ ...serverEnv, OPENAI_API_KEY: "" });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.variables).toContain("OPENAI_API_KEY");
  });

  it("warns when the ingestion worker secret is absent", () => {
    const findings = collectBootFindings({ ...serverEnv, INGESTION_WORKER_SECRET: "" });
    expect(findings.map((f) => f.severity)).toEqual(["warning"]);
  });

  it("fails on a missing service role key", () => {
    const findings = collectBootFindings({ ...serverEnv, SUPABASE_SERVICE_ROLE_KEY: undefined });
    expect(findings.some((f) => f.severity === "error" && f.code === "CONFIG_MISSING")).toBe(true);
  });

  it("cross-checks VITE_ values when they are present at runtime", () => {
    // SSR and the browser must not target different projects.
    const findings = collectBootFindings({
      ...serverEnv,
      VITE_SUPABASE_URL: `https://${OTHER_REF}.supabase.co`,
      VITE_SUPABASE_PUBLISHABLE_KEY: VALID.VITE_SUPABASE_PUBLISHABLE_KEY,
      VITE_SUPABASE_PROJECT_ID: OTHER_REF,
    });
    const found = findings.map((f) => f.code);
    expect(found).toContain("CONFIG_PROJECT_MISMATCH");
    expect(found).toContain("CONFIG_MIRROR_MISMATCH");
  });

  it("does not demand VITE_ values that are absent at runtime", () => {
    const findings = collectBootFindings({ ...serverEnv, VITE_SUPABASE_URL: "" });
    expect(findings).toEqual([]);
  });
});

describe("assertBootConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const ok = {
    SUPABASE_URL: VALID.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: VALID.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_PROJECT_ID: VALID.SUPABASE_PROJECT_ID,
    SUPABASE_SERVICE_ROLE_KEY: VALID.SUPABASE_SERVICE_ROLE_KEY,
    OPENAI_API_KEY: "sk-test",
    INGESTION_WORKER_SECRET: "0".repeat(64),
    QV_RELEASE: "test-release",
  };

  it("logs the resolved project ref so an operator can see which project this is", () => {
    // The single fact that distinguishes "wrong key" from "right key, wrong
    // project", and it is invisible otherwise.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    assertBootConfig(ok);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toContain(REF);
    expect(info.mock.calls[0]?.[0]).toContain("test-release");
  });

  it("never logs a secret value on the success path", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    assertBootConfig(ok);
    const line = String(info.mock.calls[0]?.[0]);
    expect(line).not.toContain(VALID.SUPABASE_SERVICE_ROLE_KEY);
    expect(line).not.toContain(VALID.SUPABASE_PUBLISHABLE_KEY);
  });

  it("throws and names the variable when configuration is fatal", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => assertBootConfig({ ...ok, SUPABASE_URL: undefined })).toThrow(/SUPABASE_URL/);
  });

  it("throws when a placeholder reaches the server tier", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      assertBootConfig({ ...ok, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_xxxxxxxxxxxx" }),
    ).toThrow(/Invalid API key/);
  });

  it("does not throw for warnings alone", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertBootConfig({ ...ok, OPENAI_API_KEY: "" })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not log a secret value when it throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const badKey = legacyKey({ ref: OTHER_REF, role: "anon" });
    expect(() => assertBootConfig({ ...ok, SUPABASE_SERVICE_ROLE_KEY: badKey })).toThrow();
    expect(String(error.mock.calls[0]?.[0])).not.toContain(badKey);
  });
});
