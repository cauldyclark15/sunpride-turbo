"use client";

import { Button } from "@heroui/react";
import { useState, type ReactNode } from "react";
import { mutate } from "../../lib/api/mutate";
import { normalizeError } from "../../lib/api/errors";

/** SP-0185: an admin resets a person's password and sees the temporary one once. */

export type ResetTarget = {
  profileId: string;
  name: string;
  email: string;
  role: string;
  status: string;
};

export type ResetResult = {
  temporaryPassword: string;
  expiresAt: number;
  emailed: boolean;
  email: string;
};

/** Mirrors the server rules so the button only shows where it can work (the server decides). */
export function canResetPassword(
  target: Pick<ResetTarget, "profileId" | "role" | "status" | "email">,
  canManage: boolean,
  actorRole: string | null | undefined,
  actorProfileId: string | null | undefined,
) {
  return (
    canManage &&
    target.status === "active" &&
    target.profileId !== actorProfileId &&
    !(target.role === "super_admin" && actorRole !== "super_admin") &&
    !/\.sunpride\.invalid$|\.local$/i.test(target.email)
  );
}

export const emailLine = (result: Pick<ResetResult, "emailed" | "email">) =>
  result.emailed
    ? `Also sent to ${result.email}`
    : "Email could not be sent — send it yourself";

export const EXPIRY_LINE =
  "It expires in 3 days. They will choose their own password when they sign in.";

function Dialog({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md whitespace-normal rounded-2xl border border-border bg-surface p-6 text-left shadow-lg"
      >
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {children}
      </section>
    </div>
  );
}

/** The confirm + result dialogs; `onClose` ends the flow. Exported for tests. */
export function ResetPasswordDialog({
  target,
  onClose,
  send = (profileId) =>
    mutate<ResetResult>("/api/v1/people/reset-password", { profileId }),
}: {
  target: ResetTarget;
  onClose: () => void;
  send?: (profileId: string) => Promise<ResetResult>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResetResult | null>(null);
  const [copied, setCopied] = useState(false);
  const who = target.name || target.email;

  async function confirm() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      setResult(await send(target.profileId));
    } catch (cause) {
      setError(normalizeError(cause).message);
    } finally {
      setPending(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (result)
    return (
      <Dialog title="Temporary password">
        <p className="mt-2 text-sm text-muted">
          Give this to {who}. It is shown only once.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <code
            data-testid="temporary-password"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-center font-mono text-lg tracking-wider text-foreground"
          >
            {result.temporaryPassword}
          </code>
          <Button
            size="sm"
            variant="outline"
            onPress={() => void copy(result.temporaryPassword)}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p
          className={`mt-4 text-sm ${result.emailed ? "text-foreground" : "font-medium text-danger"}`}
        >
          {emailLine(result)}
        </p>
        <p className="mt-2 text-sm text-muted">{EXPIRY_LINE}</p>
        <div className="mt-6 flex justify-end">
          <Button variant="primary" onPress={onClose}>
            Done
          </Button>
        </div>
      </Dialog>
    );

  return (
    <Dialog title="Reset password?">
      <p className="mt-2 text-sm leading-6 text-muted">
        {who} will get a temporary password and will be signed out on every
        device. They will choose their own password when they next sign in.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onPress={onClose} isDisabled={pending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          isPending={pending}
          onPress={() => void confirm()}
        >
          Reset password
        </Button>
      </div>
    </Dialog>
  );
}

export function ResetPasswordAction({ target }: { target: ResetTarget }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 whitespace-nowrap"
        onPress={() => setOpen(true)}
      >
        Reset password
      </Button>
      {open ? (
        <ResetPasswordDialog target={target} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
