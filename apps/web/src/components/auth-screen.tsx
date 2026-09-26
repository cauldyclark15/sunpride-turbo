"use client";

import { Button, Input, Label, TextField } from "@heroui/react";
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
        setError(result.error.message ?? "Sign in failed. Try again.");
        return;
      }

      router.replace(destination);
      router.refresh();
    } catch {
      setError(
        mode === "login"
          ? "Sign in failed. Check your details."
          : "Account unavailable. Check your invitation.",
      );
    } finally {
      setPending(false);
    }
  }

  if (isLoading || isAuthenticated) return <LoadingScreen label="Loading…" />;

  const isLogin = mode === "login";
  const alternateHref = isLogin
    ? `/register?next=${encodeURIComponent(destination)}`
    : `/login?next=${encodeURIComponent(destination)}`;

  return (
    <main className="grid min-h-screen place-items-center bg-background p-5">
      <section className="w-full max-w-[400px] rounded-2xl border border-border bg-surface p-6 sm:p-8">
        <Image
          src="/sunpride-logo.jpg"
          alt="Sunpride"
          width={56}
          height={56}
          priority
          className="mb-6 rounded-[7px]"
        />
        <h1 className="text-[26px] font-semibold tracking-tight text-foreground">
          {isLogin ? "Sign in" : "Create account"}
        </h1>
        <form onSubmit={submit} className="mt-6 grid gap-4">
          {!isLogin ? (
            <TextField className="grid gap-1.5">
              <Label className="text-[13px] font-medium">Full name</Label>
              <Input
                name="name"
                autoComplete="name"
                required
                className="h-10 rounded-[10px] border border-border bg-surface"
              />
            </TextField>
          ) : null}
          <TextField className="grid gap-1.5">
            <Label className="text-[13px] font-medium">Email</Label>
            <Input
              name="email"
              type="email"
              autoComplete="email"
              required
              className="h-10 rounded-[10px] border border-border bg-surface"
            />
          </TextField>
          <div className="grid gap-1.5">
            <label htmlFor="password" className="text-[13px] font-medium">
              Password
            </label>
            <PasswordInput
              id="password"
              name="password"
              minLength={8}
              autoComplete={isLogin ? "current-password" : "new-password"}
              required
              className="h-10 rounded-[10px] border border-border bg-surface"
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
          {isLogin ? "Create account" : "Sign in"}
        </Link>
      </section>
    </main>
  );
}
