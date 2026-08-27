import { PublicShell } from "@/components/queryvault/PublicShell";
import { VaultMark, Wordmark } from "@/components/queryvault/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { googleAuthEnabled, oauthRedirectTo } from "@/lib/auth-providers";
import { userMessage } from "@/lib/client-errors";
import { gsap } from "@/lib/motion/gsap";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";
import { DUR, EASE, STAGGER } from "@/lib/motion/tokens";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading && session) navigate({ to: "/chat" });
  }, [loading, session, navigate]);

  /**
   * Entrance sequence, replacing the old `animate-rise` class on the wrapper.
   *
   * A single timeline rather than one CSS animation on the whole block, so the
   * order carries meaning: you are told where you are (mark, wordmark, promise)
   * before you are shown what to do (card, then fields). It is also short —
   * roughly 900 ms end to end, with every step overlapping the one before, since
   * this is a form somebody arrived here to fill in, not a hero to admire.
   *
   * `mode` toggling re-renders but never remounts, so this runs exactly once.
   */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (prefersReducedMotion()) return;

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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/chat` },
        });
        if (error) throw error;
        // When the project requires email confirmation, signUp succeeds but
        // returns no session — the user is NOT signed in yet. Claiming "you're
        // in" left them staring at a sign-in form with no idea why.
        if (data.session) toast.success("Account created. You're in.");
        else toast.success("Check your email to confirm your account, then sign in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (error) {
      toast.error(userMessage(error, "Authentication failed."));
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true);
    try {
      // Supabase performs the redirect itself, so on success this promise
      // resolves while the browser is already navigating away — there is no
      // "signed in" branch to handle here.
      const redirectTo = oauthRedirectTo();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        // Conditional spread, not `redirectTo: undefined` — tsconfig sets
        // exactOptionalPropertyTypes, so an explicit undefined is a type error.
        options: { ...(redirectTo ? { redirectTo } : {}) },
      });
      if (error) throw error;
    } catch (error) {
      setBusy(false);
      toast.error(userMessage(error, "Google sign-in failed. Try email instead."));
    }
  };

  return (
    /* `header={false}`: a sign-in page should offer one thing to do. Lenis is
       inert here — there is nothing to scroll — but the shell is shared so the
       page keeps the same background and reduced-motion behaviour as `/`. */
    <PublicShell header={false}>
      <div className="flex min-h-screen items-center justify-center px-4">
        <div ref={rootRef} className="w-full max-w-sm">
          <div data-auth-brand className="mb-8 flex flex-col items-center gap-3 text-center">
            <VaultMark className="h-11 w-11" />
            <Wordmark className="text-xl" />
            <p className="text-sm text-muted-foreground">
              Cited answers from your own documents. Nothing invented.
            </p>
          </div>

          <div data-auth-card className="glass-panel rounded-xl p-6">
            <h1 className="text-base font-semibold text-foreground">
              {mode === "signin" ? "Sign in to your vault" : "Create your vault"}
            </h1>

            <form onSubmit={submit} className="mt-5 space-y-4">
              <div data-auth-field className="space-y-1.5">
                <Label htmlFor="email" className="text-xs text-muted-foreground">
                  Work email
                </Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  className="bg-surface/60"
                />
              </div>
              <div data-auth-field className="space-y-1.5">
                <Label htmlFor="password" className="text-xs text-muted-foreground">
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  required
                  minLength={6}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
                  className="bg-surface/60"
                />
              </div>
              <Button
                type="submit"
                data-auth-field
                disabled={busy}
                className="w-full hover:opacity-90"
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === "signin" ? "Sign in" : "Create account"}
              </Button>
            </form>

            {googleAuthEnabled && (
              <>
                <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-widest text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>

                <Button
                  variant="outline"
                  className="w-full bg-surface/40"
                  onClick={google}
                  disabled={busy}
                >
                  Continue with Google
                </Button>
              </>
            )}

            <button
              type="button"
              className="mt-5 w-full text-center text-xs text-muted-foreground transition-colors hover:text-cyan"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            >
              {mode === "signin"
                ? "No account yet? Create one"
                : "Already have an account? Sign in"}
            </button>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
