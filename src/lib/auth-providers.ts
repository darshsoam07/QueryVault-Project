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
 * Optional canonical URL for links sent by Supabase.
 *
 * `window.location.origin` is convenient for desktop development, but it is
 * not a usable address when the email is opened on a phone: `localhost` then
 * points at the phone, not the computer running QueryVault. Set VITE_APP_URL
 * to a deployed URL or to the computer's LAN URL when testing on another
 * device. When it is absent, the live origin remains the safe default.
 */
const configuredAppUrl = (import.meta.env["VITE_APP_URL"] ?? "").trim();

/** Build a redirect URL from the configured/public app origin. */
export function authRedirectTo(path = "/chat"): string | undefined {
  const baseUrl =
    configuredAppUrl || (typeof window !== "undefined" ? window.location.origin : undefined);
  if (!baseUrl) return undefined;

  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const childPath = path.replace(/^\/+/, "");
  url.pathname = `${basePath}/${childPath}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Where the provider sends the user back after consent.
 *
 * Must exactly match an entry in the Supabase project's redirect allow-list, or
 * the handshake ends on an error page. The same helper is used for email
 * confirmation and password reset so every auth flow lands on a reachable URL.
 */
export function oauthRedirectTo(): string | undefined {
  return authRedirectTo("/chat");
}
