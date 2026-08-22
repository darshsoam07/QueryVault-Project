/**
 * Configuration validation for the Supabase environment contract.
 *
 * This exists because of a real, repeatedly-misdiagnosed production failure:
 * every request returning `401 {"message":"Invalid API key"}`. That response
 * comes from the Supabase edge rejecting an `apikey` header it does not
 * recognise, and the overwhelmingly common cause is a *build* that never
 * received `VITE_SUPABASE_PUBLISHABLE_KEY` — those values are inlined at build
 * time, so an artifact built without them ships an invalid key to every browser
 * and no amount of correct server configuration can rescue it. The failure
 * surfaces far from its cause, as an authentication error rather than a
 * configuration error.
 *
 * So the checks here run at the three points where the mistake is still cheap:
 * before the build produces an artifact, when the server boots, and when the
 * browser client is constructed.
 *
 * Everything in this module is pure and isomorphic — it reads no environment
 * and performs no I/O, so it is safe to import from browser code.
 *
 * SECURITY: findings name variables and report *derived, non-secret* facts (a
 * project ref, a JWT `role` claim). A value is never interpolated into a
 * message, because these messages reach logs and HTTP responses.
 */

export type ConfigSeverity = "error" | "warning";

export type ConfigFindingCode =
  | "CONFIG_MISSING"
  | "CONFIG_PLACEHOLDER"
  | "CONFIG_URL_INVALID"
  | "CONFIG_PROJECT_MISMATCH"
  | "CONFIG_KEY_PROJECT_MISMATCH"
  | "CONFIG_KEY_ROLE_INVALID"
  | "CONFIG_SECRET_IN_PUBLIC"
  | "CONFIG_MIRROR_MISMATCH";

export type ConfigFinding = {
  severity: ConfigSeverity;
  code: ConfigFindingCode;
  /** Variable names involved. Names are safe to log; values never are. */
  variables: string[];
  message: string;
};

/**
 * Substrings that mark a value as a stand-in rather than a real credential.
 * Drawn from the placeholders this repository actually ships — `.env.example`
 * (`your-project-ref`, `sb_publishable_xxxx…`) and the CI build step
 * (`ci-placeholder`) — plus the conventional ones people type by hand.
 */
const PLACEHOLDER_MARKERS = [
  "your-project",
  "your_project",
  "placeholder",
  "changeme",
  "change-me",
  "example.supabase.co",
  "todo",
  "xxxx",
];

/** True when a value is absent, blank, or a recognised stand-in. */
export function isPlaceholder(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("<") || lower.endsWith(">")) return true;
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * The project ref embedded in a Supabase URL — `https://<ref>.supabase.co`.
 * Returns null for anything that is not a parseable https URL, so callers can
 * distinguish "malformed" from "mismatched".
 */
export function projectRefFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const [ref, ...rest] = parsed.hostname.split(".");
  // A self-hosted Supabase behind a custom domain has no ref to extract; that is
  // not an error, just unverifiable here.
  if (!ref || rest.length === 0) return null;
  return ref;
}

type JwtClaims = { ref?: string; role?: string };

/**
 * Claims from a legacy Supabase API key (a signed JWT carrying `ref` and
 * `role`). Signature is not verified — this is a configuration sanity check,
 * not authentication, and the server it points at is the only thing that can
 * validate the signature anyway.
 */
export function readLegacyKeyClaims(value: string | undefined): JwtClaims | null {
  if (!value || !value.startsWith("eyJ")) return null;
  const segments = value.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload = segments[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    const decoded = JSON.parse(atob(padded)) as JwtClaims;
    return typeof decoded === "object" && decoded !== null ? decoded : null;
  } catch {
    return null;
  }
}

/** The project a key claims to belong to, for whichever key generation it is. */
function refOfKey(value: string | undefined): string | null {
  return readLegacyKeyClaims(value)?.ref ?? null;
}

/** `anon` / `service_role` for legacy JWTs; inferred from the prefix otherwise. */
function roleOfKey(value: string | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("sb_publishable_")) return "anon";
  if (value.startsWith("sb_secret_")) return "service_role";
  return readLegacyKeyClaims(value)?.role ?? null;
}

export type SupabaseConfigInput = {
  VITE_SUPABASE_URL?: string | undefined;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string | undefined;
  VITE_SUPABASE_PROJECT_ID?: string | undefined;
  SUPABASE_URL?: string | undefined;
  SUPABASE_PUBLISHABLE_KEY?: string | undefined;
  SUPABASE_PROJECT_ID?: string | undefined;
  SUPABASE_SERVICE_ROLE_KEY?: string | undefined;
};

/** Which tier to check. The browser has no access to the server tier. */
export type ConfigTier = "public" | "server";

const PUBLIC_REQUIRED = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_PROJECT_ID",
] as const;

const SERVER_REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_PROJECT_ID",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

/**
 * Validates one or both tiers of the Supabase contract.
 *
 * Ordered so the most actionable finding comes first: a variable that is
 * missing or a placeholder is reported on its own, because every downstream
 * check on that value would only add noise.
 */
export function validateSupabaseConfig(
  input: SupabaseConfigInput,
  tiers: ConfigTier[] = ["public", "server"],
): ConfigFinding[] {
  const findings: ConfigFinding[] = [];
  const checkPublic = tiers.includes("public");
  const checkServer = tiers.includes("server");

  const required = [
    ...(checkPublic ? PUBLIC_REQUIRED : []),
    ...(checkServer ? SERVER_REQUIRED : []),
  ] as Array<keyof SupabaseConfigInput>;

  const unusable = new Set<string>();
  for (const name of required) {
    const value = input[name];
    if (value === undefined || value === null || value.trim().length === 0) {
      unusable.add(name);
      findings.push({
        severity: "error",
        code: "CONFIG_MISSING",
        variables: [name],
        message: `${name} is not set. See .env.example for the required contract.`,
      });
      continue;
    }
    if (isPlaceholder(value)) {
      unusable.add(name);
      findings.push({
        severity: "error",
        code: "CONFIG_PLACEHOLDER",
        variables: [name],
        message:
          `${name} still holds a placeholder value. A build or deployment carrying ` +
          `a placeholder key fails every request with "Invalid API key".`,
      });
    }
  }

  const usable = (name: keyof SupabaseConfigInput): string | undefined =>
    unusable.has(name) ? undefined : (input[name] ?? undefined);

  // A secret in a VITE_ variable is the single worst configuration mistake
  // available here: it publishes an RLS-bypassing credential to every browser.
  if (checkPublic) {
    const publicKey = usable("VITE_SUPABASE_PUBLISHABLE_KEY");
    if (publicKey && roleOfKey(publicKey) === "service_role") {
      findings.push({
        severity: "error",
        code: "CONFIG_SECRET_IN_PUBLIC",
        variables: ["VITE_SUPABASE_PUBLISHABLE_KEY"],
        message:
          "VITE_SUPABASE_PUBLISHABLE_KEY holds a service-role key. VITE_ values are " +
          "inlined into the browser bundle, so this would publish a key that bypasses " +
          "Row Level Security. Rotate it immediately and set the publishable key instead.",
      });
    }
  }

  if (checkServer) {
    const serviceKey = usable("SUPABASE_SERVICE_ROLE_KEY");
    const role = roleOfKey(serviceKey);
    if (serviceKey && role !== null && role !== "service_role") {
      findings.push({
        severity: "error",
        code: "CONFIG_KEY_ROLE_INVALID",
        variables: ["SUPABASE_SERVICE_ROLE_KEY"],
        message:
          `SUPABASE_SERVICE_ROLE_KEY carries role "${role}", not "service_role". ` +
          "Server-authoritative writes and the ingestion worker will fail on RLS.",
      });
    }
  }

  // URL/project/key agreement. Every value below is a project ref or a role
  // name — non-secret, and naming them is what makes a mismatch diagnosable.
  const refs = new Map<string, string>();
  const addRef = (name: string, ref: string | null) => {
    if (ref) refs.set(name, ref);
  };

  if (checkPublic) {
    const url = usable("VITE_SUPABASE_URL");
    if (url && projectRefFromUrl(url) === null) {
      findings.push({
        severity: "error",
        code: "CONFIG_URL_INVALID",
        variables: ["VITE_SUPABASE_URL"],
        message: "VITE_SUPABASE_URL is not a parseable https Supabase URL.",
      });
    }
    addRef("VITE_SUPABASE_URL", projectRefFromUrl(url));
    addRef("VITE_SUPABASE_PROJECT_ID", usable("VITE_SUPABASE_PROJECT_ID") ?? null);
    addRef("VITE_SUPABASE_PUBLISHABLE_KEY", refOfKey(usable("VITE_SUPABASE_PUBLISHABLE_KEY")));
  }

  if (checkServer) {
    const url = usable("SUPABASE_URL");
    if (url && projectRefFromUrl(url) === null) {
      findings.push({
        severity: "error",
        code: "CONFIG_URL_INVALID",
        variables: ["SUPABASE_URL"],
        message: "SUPABASE_URL is not a parseable https Supabase URL.",
      });
    }
    addRef("SUPABASE_URL", projectRefFromUrl(url));
    addRef("SUPABASE_PROJECT_ID", usable("SUPABASE_PROJECT_ID") ?? null);
    addRef("SUPABASE_PUBLISHABLE_KEY", refOfKey(usable("SUPABASE_PUBLISHABLE_KEY")));
    addRef("SUPABASE_SERVICE_ROLE_KEY", refOfKey(usable("SUPABASE_SERVICE_ROLE_KEY")));
  }

  const distinct = [...new Set(refs.values())];
  if (distinct.length > 1) {
    const grouped = [...refs.entries()]
      .map(([name, ref]) => `${name}=${ref}`)
      .sort()
      .join(", ");
    // A key from one project sent to another project's URL is rejected as
    // "Invalid API key" — indistinguishable, from the browser, from no key.
    findings.push({
      severity: "error",
      code: "CONFIG_PROJECT_MISMATCH",
      variables: [...refs.keys()],
      message: `Supabase configuration spans more than one project: ${grouped}.`,
    });
  }

  // Only meaningful when both tiers are present: the unprefixed variables are
  // meant to mirror the VITE_ ones, and a silent divergence means SSR and the
  // browser talk to different projects.
  if (checkPublic && checkServer) {
    const mirrors: Array<[keyof SupabaseConfigInput, keyof SupabaseConfigInput]> = [
      ["VITE_SUPABASE_URL", "SUPABASE_URL"],
      ["VITE_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEY"],
      ["VITE_SUPABASE_PROJECT_ID", "SUPABASE_PROJECT_ID"],
    ];
    for (const [publicName, serverName] of mirrors) {
      const a = usable(publicName);
      const b = usable(serverName);
      if (a && b && a !== b) {
        findings.push({
          severity: "error",
          code: "CONFIG_MIRROR_MISMATCH",
          variables: [publicName, serverName],
          message:
            `${publicName} and ${serverName} differ. They must hold the same value; ` +
            "otherwise the browser and the server target different configuration.",
        });
      }
    }
  }

  return findings;
}

/** True when any finding would make the deployment non-functional. */
export function hasFatalFinding(findings: ConfigFinding[]): boolean {
  return findings.some((finding) => finding.severity === "error");
}

/** One line per finding, safe to print. Never contains a secret value. */
export function formatFindings(findings: ConfigFinding[]): string {
  return findings
    .map((finding) => `  [${finding.severity}] ${finding.code}: ${finding.message}`)
    .join("\n");
}
