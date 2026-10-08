import { PublicShell } from "@/components/queryvault/PublicShell";
import { VaultMark, Wordmark } from "@/components/queryvault/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { authRedirectTo, googleAuthEnabled, oauthRedirectTo } from "@/lib/auth-providers";
import { userMessage } from "@/lib/client-errors";
import { gsap } from "@/lib/motion/gsap";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import { DUR, EASE, STAGGER } from "@/lib/motion/tokens";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

type AuthMode = "signin" | "signup" | "reset" | "update";
type AuthErrorLike = { message?: unknown };

function authErrorMessage(error: unknown, fallback: string): string {
  const rawMessage =
    typeof error === "object" && error !== null ? (error as AuthErrorLike).message : null;
  const message = typeof rawMessage === "string" ? rawMessage.toLowerCase() : "";
  if (message.includes("invalid login credentials"))
    return "Invalid email or password. Check your password with the eye icon, and confirm your email if you just signed up.";
  if (message.includes("email not confirmed"))
    return "Your email has not been confirmed yet. Check your inbox or resend the confirmation email.";
  if (message.includes("rate limit") || message.includes("too many requests"))
    return "Too many attempts. Please wait a moment and try again.";
  if (message.includes("password") && (message.includes("short") || message.includes("least")))
    return "Your password must be at least 8 characters.";
  if (message.includes("failed to fetch") || message.includes("network"))
    return "We could not reach the authentication service. Check your connection and try again.";
  return userMessage(error, fallback);
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  minLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div data-auth-field className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          required
          {...(minLength ? { minLength } : {})}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="••••••••"
          className="bg-surface/60 pr-10"
        />
        <button
          type="button"
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — QueryVault AI Knowledge Assistant" },
      {
        name: "description",
        content:
          "Sign in to QueryVault to upload documents and get cited answers from your private knowledge base.",
      },
      { property: "og:title", content: "Sign in — QueryVault" },
      {
        property: "og:description",
        content: "Private, cited answers from your own document library.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { session, loading } = useAuth();
  const recoveryRef = useRef(
    typeof window !== "undefined" &&
      new URLSearchParams(window.location.hash.slice(1)).get("type") === "recovery",
  );
  const [mode, setMode] = useState<AuthMode>(recoveryRef.current ? "update" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmationNotice, setConfirmationNotice] = useState("");
  const [resendAvailable, setResendAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const enterRecovery = () => {
      recoveryRef.current = true;
      setMode("update");
      setPassword("");
      setConfirmPassword("");
      setConfirmationNotice("");
      setResendAvailable(false);
    };
    if (
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.hash.slice(1)).get("type") === "recovery"
    )
      enterRecovery();
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") enterRecovery();
    });
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!loading && session && !recoveryRef.current) navigate({ to: "/chat" });
  }, [loading, session, navigate]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: EASE.out } });
      tl.from("[data-auth-brand] > *", {
        y: -8,
        opacity: 0,
        duration: DUR.card,
        stagger: STAGGER.tight,
      })
        .from("[data-auth-card]", { y: 16, opacity: 0, duration: DUR.page }, "-=0.3")
        .from(
          "[data-auth-field]",
          { y: 8, opacity: 0, duration: DUR.micro, stagger: STAGGER.tight },
          "-=0.35",
        );
    }, root);
    return () => ctx.revert();
  }, []);
  const normalizedEmail = () => email.trim().toLowerCase();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if ((mode === "signup" || mode === "update") && password !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }
    setBusy(true);
    setResendAvailable(false);
    try {
      if (mode === "reset") {
        const redirectTo = authRedirectTo("/auth");
        const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail(), {
          ...(redirectTo ? { redirectTo } : {}),
        });
        if (error) throw error;
        toast.success("Check your email for a password-reset link.");
        setMode("signin");
        return;
      }
      if (mode === "update") {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        recoveryRef.current = false;
        toast.success("Your password has been updated.");
        navigate({ to: "/chat" });
        return;
      }
      if (mode === "signup") {
        const redirectTo = authRedirectTo("/chat");
        const { data, error } = await supabase.auth.signUp({
          email: normalizedEmail(),
          password,
          options: { ...(redirectTo ? { emailRedirectTo: redirectTo } : {}) },
        });
        if (error) throw error;
        if (data.user?.identities?.length === 0) {
          setMode("signin");
          toast.error("An account with this email already exists. Please sign in instead.");
          return;
        }
        if (data.session) {
          toast.success("Account created. You're in.");
        } else {
          const confirmedEmail = normalizedEmail();
          setConfirmationNotice(
            `We sent a confirmation link to ${confirmedEmail}. Open it, then come back here and sign in.`,
          );
          setMode("signin");
          setPassword("");
          setConfirmPassword("");
        }
        return;
      }
      const { error } = await supabase.auth.signInWithPassword({
        email: normalizedEmail(),
        password,
      });
      if (error) throw error;
    } catch (error) {
      const message = authErrorMessage(error, "Authentication failed.");
      setResendAvailable(message.includes("not been confirmed"));
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };
  const resendConfirmation = async () => {
    setBusy(true);
    try {
      const redirectTo = authRedirectTo("/chat");
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: normalizedEmail(),
        options: { ...(redirectTo ? { emailRedirectTo: redirectTo } : {}) },
      });
      if (error) throw error;
      toast.success("Confirmation email sent.");
      setResendAvailable(false);
    } catch (error) {
      toast.error(authErrorMessage(error, "Could not resend the confirmation email."));
    } finally {
      setBusy(false);
    }
  };
  const google = async () => {
    setBusy(true);
    try {
      const redirectTo = oauthRedirectTo();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { ...(redirectTo ? { redirectTo } : {}) },
      });
      if (error) throw error;
    } catch (error) {
      setBusy(false);
      toast.error(authErrorMessage(error, "Google sign-in failed. Try email instead."));
    }
  };
  const cardTitle =
    mode === "signin"
      ? "Sign in to your vault"
      : mode === "signup"
        ? "Create your vault"
        : mode === "update"
          ? "Choose a new password"
          : "Reset your password";
  const submitLabel =
    mode === "signin"
      ? "Sign in"
      : mode === "signup"
        ? "Create account"
        : mode === "update"
          ? "Update password"
          : "Send reset link";
  return (
    <PublicShell header={false} variant="neutral" smoothScroll={false}>
      <div className="flex min-h-screen items-center justify-center px-4">
        <div ref={rootRef} className="w-full max-w-sm">
          <div data-auth-brand className="mb-8 flex flex-col items-center gap-3 text-center">
            <VaultMark className="h-11 w-11" />
            <Wordmark className="text-xl" />
            <p className="text-sm text-muted-foreground">
              Cited answers from your own documents. Nothing invented.
            </p>
          </div>
          <div data-auth-card className="glass-panel rounded-2xl p-6 shadow-[var(--glow-amethyst)]">
            <h1 className="text-base font-semibold text-foreground">{cardTitle}</h1>
            {confirmationNotice && (
              <p className="mt-3 text-sm text-muted-foreground">{confirmationNotice}</p>
            )}
            <form onSubmit={submit} className="mt-5 space-y-4">
              {mode !== "update" && (
                <div data-auth-field className="space-y-1.5">
                  <Label htmlFor="email" className="text-xs text-muted-foreground">
                    Work email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@company.com"
                    className="bg-surface/60"
                  />
                </div>
              )}
              {mode !== "reset" && (
                <PasswordField
                  id="password"
                  label="Password"
                  value={password}
                  onChange={setPassword}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  {...(mode === "signup" || mode === "update" ? { minLength: 8 } : {})}
                />
              )}
              {(mode === "signup" || mode === "update") && (
                <PasswordField
                  id="confirm-password"
                  label="Confirm password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  autoComplete="new-password"
                  minLength={8}
                />
              )}
              <Button
                type="submit"
                data-auth-field
                disabled={busy}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {submitLabel}
              </Button>
            </form>
            {resendAvailable && (
              <Button
                type="button"
                variant="outline"
                className="mt-3 w-full bg-surface/40 hover:bg-surface/80 border-border"
                onClick={resendConfirmation}
                disabled={busy}
              >
                Resend confirmation email
              </Button>
            )}
            {googleAuthEnabled && (mode === "signin" || mode === "signup") && (
              <>
                <div className="my-4 flex items-center gap-3 technical-label text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>
                <Button
                  variant="outline"
                  className="w-full bg-surface/40 hover:bg-surface/80 border-border"
                  onClick={google}
                  disabled={busy}
                >
                  Continue with Google
                </Button>
              </>
            )}
            <div className="mt-5 flex flex-col items-center gap-2">
              {mode === "signin" && (
                <>
                  <button
                    type="button"
                    className="text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setMode("signup")}
                  >
                    No account yet? Create one
                  </button>
                  <button
                    type="button"
                    className="text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setMode("reset")}
                  >
                    Forgot your password?
                  </button>
                </>
              )}
              {mode === "signup" && (
                <button
                  type="button"
                  className="text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => setMode("signin")}
                >
                  Already have an account? Sign in
                </button>
              )}
              {mode === "reset" && (
                <button
                  type="button"
                  className="text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => setMode("signin")}
                >
                  Back to sign in
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
