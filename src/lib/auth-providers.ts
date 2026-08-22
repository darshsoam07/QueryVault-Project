/**
 * Which third-party sign-in providers this deployment offers.
 *
 * A social button is only useful if the Supabase project behind it actually has
 * that provider enabled (Dashboard → Authentication → Providers) *and* has this
 * origin in its redirect allow-list. When it doesn't, `signInWithOAuth` fails
 * with "provider is not enabled" — so rendering the button unconditionally ships
 * a control that is guaranteed to error. We gate on an explicit opt-in instead.
 *
 * These are `VITE_`-prefixed and therefore public: they are feature flags, not
 * secrets. Never add a provider *secret* here — OAuth client secrets live in the
 * Supabase project config, and the browser never sees them.
 */

/** True when the operator has confirmed Google is configured for this deployment. */
export const googleAuthEnabled =
  (import.meta.env["VITE_ENABLE_GOOGLE_AUTH"] ?? "").toLowerCase() === "true";

/**
 * Where the provider sends the user back after consent.
 *
 * Must exactly match an entry in the Supabase project's redirect allow-list, or
 * the handshake ends on an error page. Computed from the live origin so the same
 * build works in local dev and in production without rebuilding.
 */
export function oauthRedirectTo(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return `${window.location.origin}/chat`;
}
