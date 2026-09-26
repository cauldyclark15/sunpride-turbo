import { Button, Input, Label, TextField } from "@heroui/react";
import { PasswordInput } from "@sunpride/ui";
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
        setError(result.error.message ?? "Sign in failed. Try again.");
        return;
      }
      navigate("/", { replace: true });
    } catch {
      setError(
        isLogin
          ? "Sign in failed. Check your details."
          : "Account unavailable. Check your invitation.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-5">
      <section className="w-full max-w-[400px] rounded-2xl border border-border bg-surface p-6 sm:p-8">
        <img
          src="/sunpride-logo.jpg"
          alt="Sunpride"
          width="64"
          height="64"
          className="rounded-[7px]"
        />
        <h1 className="mt-6 text-[26px] font-semibold tracking-tight text-foreground">
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
            />
          </div>
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
        <p className="mt-5 text-sm text-muted">
          {isLogin ? "No account? " : "Already have an account? "}
          <Link
            to={isLogin ? "/register" : "/login"}
            className="font-medium text-accent hover:underline"
          >
            {isLogin ? "Create one" : "Sign in"}
          </Link>
        </p>
      </section>
    </main>
  );
}
