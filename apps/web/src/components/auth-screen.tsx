"use client";

import { Button, Input } from "@heroui/react";
import { useConvexAuth } from "convex/react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { PasswordInput } from "@sunpride/ui";
import { LoadingScreen } from "@/components/auth-gate";
import { authClient } from "@/lib/auth-client";
import { safeAuthDestination } from "@/lib/auth-routing";

type AuthMode = "login" | "register";

export function AuthScreen({ mode, next }: { mode: AuthMode; next?: string }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const destination = safeAuthDestination(next);

  useEffect(() => {
    if (isAuthenticated) router.replace(destination);
  }, [destination, isAuthenticated, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "")
      .trim()
      .toLowerCase();
    const password = String(data.get("password") ?? "");
    const name = String(data.get("name") ?? "Sunpride User").trim();

    try {
      const result =
        mode === "login"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name });

      if (result.error) {
        setError(result.error.message ?? "Unable to continue.");
        return;
      }

      router.replace(destination);
      router.refresh();
    } catch {
      setError(
        mode === "login"
          ? "Unable to sign in. Check your email and password."
          : "Unable to create this account. Confirm that the email was invited.",
      );
    } finally {
      setPending(false);
    }
  }

  if (isLoading || isAuthenticated)
    return <LoadingScreen label="Opening Sunpride Operations…" />;

  const isLogin = mode === "login";
  const alternateHref = isLogin
    ? `/register?next=${encodeURIComponent(destination)}`
    : `/login?next=${encodeURIComponent(destination)}`;

  return (
    <main className="grid min-h-screen place-items-center border-t-4 border-accent bg-background p-6">
      <section className="w-full max-w-md rounded-lg border border-border bg-surface p-7 shadow-none sm:p-8">
        <Image
          src="/sunpride-logo.jpg"
          alt="Sunpride"
          width={72}
          height={72}
          priority
          className="mb-6 rounded-[7px]"
        />
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-soft-foreground">
          Integrated Operations
        </p>
        <h1 className="mt-2 text-[1.625rem] font-semibold leading-9 tracking-tight text-foreground">
          {isLogin ? "Sign in to Sunpride" : "Create your account"}
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
          <div className="grid gap-1.5">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <PasswordInput
              id="password"
              name="password"
              minLength={8}
              autoComplete={isLogin ? "current-password" : "new-password"}
              required
            />
          </div>
          {error ? (
            <p
              role="alert"
              className="rounded-md bg-danger-soft px-3 py-2 text-sm font-medium text-danger-soft-foreground"
            >
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            isPending={pending}
            className="mt-2 w-full"
          >
            {isLogin ? "Sign in" : "Create account"}
          </Button>
        </form>
        <Link
          href={alternateHref}
          className="mt-5 block w-full text-center text-sm font-medium text-muted hover:text-foreground"
        >
          {isLogin
            ? "First time here? Create your account"
            : "Already registered? Sign in"}
        </Link>
      </section>
    </main>
  );
}
