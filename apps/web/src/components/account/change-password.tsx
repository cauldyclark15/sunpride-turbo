"use client";

import { Button } from "@heroui/react";
import { PasswordInput } from "@sunpride/ui";
import { useRef, useState, type FormEvent } from "react";
import { mutate, normalizeError } from "../../lib/api";

/**
 * `forced` (SP-0185): after an admin reset, the current password is the temporary one and
 * `onChanged` lets the signed-in shell open once the new password is saved.
 */
export function ChangePassword({
  forced = false,
  onChanged,
}: {
  forced?: boolean;
  onChanged?: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const sending = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");
    setError(null);
    setSuccess(false);
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match. Enter them again.");
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      setError("Choose a password between 8 and 128 characters.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("Choose a different password from your current one.");
      return;
    }
    sending.current = true;
    setPending(true);
    try {
      await mutate("/api/auth/change-password", {
        currentPassword,
        newPassword,
      });
      form.reset();
      setSuccess(true);
      onChanged?.();
    } catch (cause) {
      const failure = normalizeError(cause);
      setError(failure.message);
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="change-password-title"
      className="rounded-2xl border border-border bg-surface p-5 sm:p-6"
    >
      <h2
        id="change-password-title"
        className="text-lg font-semibold tracking-tight"
      >
        {forced ? "Set a new password" : "Change password"}
      </h2>
      <p className="mt-2 text-sm text-muted">
        {forced
          ? "Your password was reset. Enter the temporary password you were given, then choose your own password (8 to 128 characters)."
          : "Choose 8 to 128 characters. Your other devices will be signed out."}
      </p>
      <form
        onSubmit={submit}
        className="mt-6 grid max-w-md gap-4"
        aria-describedby={error ? "password-error" : undefined}
      >
        {(
          [
            [
              "currentPassword",
              forced ? "Temporary password" : "Current password",
              "current-password",
            ],
            ["newPassword", "New password", "new-password"],
            ["confirmPassword", "Confirm new password", "new-password"],
          ] as const
        ).map(([name, label, autoComplete]) => (
          <div key={name} className="grid gap-1.5">
            <label htmlFor={name} className="text-[13px] font-medium">
              {label}
            </label>
            <PasswordInput
              id={name}
              name={name}
              autoComplete={autoComplete}
              required
              minLength={name === "currentPassword" ? undefined : 8}
              maxLength={name === "currentPassword" ? 256 : 128}
              disabled={pending}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "password-error" : undefined}
            />
          </div>
        ))}
        {error ? (
          <p id="password-error" role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        {success ? (
          <p role="status" className="text-sm text-foreground">
            Password changed. Other devices were signed out.
          </p>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          isPending={pending}
          className="mt-1 justify-self-start"
        >
          {forced ? "Set new password" : "Change password"}
        </Button>
      </form>
    </section>
  );
}
