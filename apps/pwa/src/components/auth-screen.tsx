import { Button, Input } from "@heroui/react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { authClient } from "../lib/auth-client";

export function AuthScreen({ mode }: { mode: "login" | "register" }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLogin = mode === "login";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "")
      .trim()
      .toLowerCase();
    const password = String(data.get("password") ?? "");
    const name = String(data.get("name") ?? "Sunpride Field User").trim();
    try {
      const result = isLogin
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name });
      if (result.error) {
        setError(result.error.message ?? "Unable to continue.");
        return;
      }
      navigate("/", { replace: true });
    } catch {
      setError(
        isLogin
          ? "Unable to sign in. Check your email and password."
          : "Unable to create this account. Confirm that the email was invited.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center border-t-4 border-accent bg-background p-5">
      <section className="w-full max-w-md rounded-lg border border-border bg-surface p-7 shadow-none sm:p-8">
        <img
          src="/sunpride-logo.jpg"
          alt="Sunpride"
          width="64"
          height="64"
          className="rounded-[7px]"
        />
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-accent-soft-foreground">
          Field operations PWA
        </p>
        <h1 className="mt-2 text-[1.625rem] font-semibold leading-9 tracking-tight text-foreground">
          {isLogin ? "Sign in for field work" : "Create field account"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          Access is invitation-only. Use the email address authorized by your
          Sunpride administrator.
        </p>
        <form onSubmit={submit} className="mt-7 grid gap-4">
          {!isLogin ? (
            <label className="grid gap-1.5 text-sm font-medium">
              Full name
              <Input name="name" autoComplete="name" required />
            </label>
          ) : null}
          <label className="grid gap-1.5 text-sm font-medium">
            Email address
            <Input name="email" type="email" autoComplete="email" required />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Password
            <Input
              name="password"
              type="password"
              minLength={8}
              autoComplete={isLogin ? "current-password" : "new-password"}
              required
            />
          </label>
          {error ? (
            <p
              role="alert"
              className="rounded-md bg-danger-soft p-3 text-sm text-danger-soft-foreground"
            >
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            isPending={pending}
            className="mt-1 w-full"
          >
            {isLogin ? "Sign in" : "Create account"}
          </Button>
        </form>
        <Link
          to={isLogin ? "/register" : "/login"}
          className="mt-5 block text-center text-sm font-medium text-muted hover:text-foreground"
        >
          {isLogin
            ? "First visit? Create your account"
            : "Already registered? Sign in"}
        </Link>
      </section>
    </main>
  );
}
