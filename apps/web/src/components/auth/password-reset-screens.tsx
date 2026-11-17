"use client";

import { Button, Input, Label, TextField } from "@heroui/react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { PasswordInput } from "@sunpride/ui";
import { apiFetch } from "../../lib/api/fetch";
import { isApiError, normalizeError } from "../../lib/api/errors";

/** SP-0185: public "Forgot password?" and "Choose a new password" screens (no session needed). */

export const FORGOT_SENT_MESSAGE =
  "If that email has an account, we sent a link. Check your inbox and spam folder.";
export const RESET_LINK_INVALID_MESSAGE =
  "This link is no longer valid. Ask for a new one.";

/** Checks the two new-password fields the same way the server does; null when fine. */
export function newPasswordProblem(password: string, confirm: string) {
  if (password !== confirm)
    return "The new passwords do not match. Enter them again.";
  if (password.length < 8 || password.length > 128)
    return "Choose a password between 8 and 128 characters.";
  return null;
}

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
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
          {title}
        </h1>
        {children}
        <Link
          href="/login"
          className="mt-5 block w-full text-center text-sm font-medium text-muted hover:text-foreground"
        >
          Back to sign in
        </Link>
      </section>
    </main>
  );
}

export function ForgotPasswordScreen() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "")
      .trim()
      .toLowerCase();
    setPending(true);
    setError(null);
    try {
      await apiFetch("/api/auth/forgot-password", {
        method: "POST",
        body: { email },
      });
      setSent(true);
    } catch (cause) {
      setError(
        isApiError(cause, "rate_limited")
          ? "Too many requests. Wait a few minutes, then try again."
          : normalizeError(cause).message,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthCard title="Forgot password">
      {sent ? (
        <p
          role="status"
          className="mt-4 rounded-md bg-success-soft px-3 py-2 text-sm font-medium text-success-soft-foreground"
        >
          {FORGOT_SENT_MESSAGE}
        </p>
      ) : (
        <>
          <p className="mt-2 text-[13px] leading-5 text-muted">
            Enter the email address you sign in with. We will email you a link
            to choose a new password.
          </p>
          <form onSubmit={submit} className="mt-6 grid gap-4">
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
              Send link
            </Button>
          </form>
        </>
      )}
    </AuthCard>
  );
}

export function ResetPasswordScreen({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(!token);
  const sending = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const data = new FormData(event.currentTarget);
    const newPassword = String(data.get("newPassword") ?? "");
    const problem = newPasswordProblem(
      newPassword,
      String(data.get("confirmPassword") ?? ""),
    );
    setError(problem);
    if (problem) return;
    sending.current = true;
    setPending(true);
    try {
      await apiFetch("/api/auth/reset-password", {
        method: "POST",
        body: { token, newPassword },
      });
      router.replace("/login?reset=done");
    } catch (cause) {
      if (isApiError(cause, "reset_link_invalid")) setInvalid(true);
      else setError(normalizeError(cause).message);
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  if (invalid)
    return (
      <AuthCard title="Link no longer valid">
        <p role="alert" className="mt-3 text-sm leading-6 text-muted">
          {RESET_LINK_INVALID_MESSAGE}
        </p>
        <Link
          href="/forgot-password"
          className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-[10px] bg-accent text-sm font-medium text-accent-foreground"
        >
          Ask for a new link
        </Link>
      </AuthCard>
    );

  return (
    <AuthCard title="Choose a new password">
      <p className="mt-2 text-[13px] leading-5 text-muted">
        Choose 8 to 128 characters. You will be signed out everywhere else.
      </p>
      <form onSubmit={submit} className="mt-6 grid gap-4">
        {(
          [
            ["newPassword", "New password"],
            ["confirmPassword", "Confirm new password"],
          ] as const
        ).map(([name, label]) => (
          <div key={name} className="grid gap-1.5">
            <label htmlFor={name} className="text-[13px] font-medium">
              {label}
            </label>
            <PasswordInput
              id={name}
              name={name}
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              disabled={pending}
            />
          </div>
        ))}
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
          Save new password
        </Button>
      </form>
    </AuthCard>
  );
}
