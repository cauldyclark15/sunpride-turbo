"use client";

import { Button, Input } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { StatusPill } from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";

type AssignableRole = "admin" | "manager" | "approver" | "sales" | "viewer";

const roles: { value: AssignableRole; label: string }[] = [
  { value: "admin", label: "Administrator" },
  { value: "manager", label: "Manager" },
  { value: "approver", label: "Approver" },
  { value: "sales", label: "Sales" },
  { value: "viewer", label: "Viewer" },
];

const roleLabel = (role: string) =>
  role
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const readableError = (error: unknown) =>
  error instanceof Error ? error.message : "The access update failed.";

export function AdminWorkspace() {
  const current = useQuery(api.domains.profiles.current, {});
  const canAdminister =
    current?.role === "super_admin" || current?.role === "admin";
  const profiles = useQuery(
    api.domains.profiles.list,
    canAdminister ? {} : "skip",
  );
  const invitations = useQuery(
    api.domains.profiles.listInvitations,
    canAdminister ? {} : "skip",
  );
  const invite = useMutation(api.domains.profiles.invite);
  const revoke = useMutation(api.domains.profiles.revoke);
  const [role, setRole] = useState<AssignableRole>("viewer");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  if (!current)
    return <p className="text-sm text-muted">Loading access controls…</p>;
  if (!canAdminister)
    return (
      <section className="rounded-lg border border-warning bg-warning-soft p-6">
        <h2 className="font-bold text-warning-soft-foreground">
          Administrator access required
        </h2>
        <p className="mt-2 text-sm text-warning-soft-foreground">
          Your current role cannot invite or manage Sunpride users.
        </p>
      </section>
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "");
    const name = String(data.get("name") ?? "").trim();
    try {
      await invite({ email, role, ...(name ? { name } : {}) });
      setMessage({
        tone: "success",
        text: `${email.toLowerCase()} can now create an account and sign in.`,
      });
      form.reset();
      setRole("viewer");
    } catch (error) {
      setMessage({ tone: "error", text: readableError(error) });
    } finally {
      setPending(false);
    }
  }

  async function revokeAccess(invitationId: Id<"accessInvitations">) {
    setMessage(null);
    try {
      await revoke({ invitationId });
      setMessage({ tone: "success", text: "Access has been revoked." });
    } catch (error) {
      setMessage({ tone: "error", text: readableError(error) });
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
      <section className="rounded-lg border border-border bg-surface p-6 shadow-none">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-soft-foreground">
          Invitation-only access
        </p>
        <h2 className="mt-2 text-xl font-semibold text-foreground">
          Add a Sunpride user
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Add the exact email the user will register with. Only the super admin
          can grant the Administrator role.
        </p>
        <form onSubmit={submit} className="mt-6 grid gap-4">
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            Full name (optional)
            <Input name="name" placeholder="Juan Dela Cruz" />
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            Email address
            <Input
              name="email"
              type="email"
              placeholder="name@sunpride.com.ph"
              required
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            Initial role
            <select
              value={role}
              onChange={(event) =>
                setRole(event.target.value as AssignableRole)
              }
              className="h-10 rounded-md border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
            >
              {roles
                .filter(
                  (option) =>
                    option.value !== "admin" || current.role === "super_admin",
                )
                .map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
            </select>
          </label>
          {message ? (
            <p
              role="status"
              className={`rounded-md px-3 py-2 text-sm font-medium ${message.tone === "success" ? "bg-success-soft text-success-soft-foreground" : "bg-danger-soft text-danger-soft-foreground"}`}
            >
              {message.text}
            </p>
          ) : null}
          <Button type="submit" variant="primary" isPending={pending}>
            Authorize email address
          </Button>
        </form>
      </section>

      <div className="grid content-start gap-6">
        <section className="rounded-lg border border-border bg-surface p-6 shadow-none">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                Active users
              </h2>
              <p className="mt-1 text-sm text-muted">
                Provisioned identities and their effective roles.
              </p>
            </div>
            <StatusPill tone="success">
              {profiles?.length ?? 0} users
            </StatusPill>
          </div>
          <div className="mt-5 grid gap-3">
            {(profiles ?? []).map((profile) => (
              <article
                key={profile._id}
                className="flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium text-foreground">{profile.name}</p>
                  <p className="mt-1 text-xs text-muted">{profile.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill
                    tone={profile.status === "active" ? "success" : "neutral"}
                  >
                    {profile.status}
                  </StatusPill>
                  <StatusPill
                    tone={profile.role === "super_admin" ? "danger" : "neutral"}
                  >
                    {roleLabel(profile.role)}
                  </StatusPill>
                </div>
              </article>
            ))}
            {profiles?.length === 0 ? (
              <p className="rounded-md bg-surface-secondary p-5 text-center text-sm text-muted">
                No provisioned users yet.
              </p>
            ) : null}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-surface p-6 shadow-none">
          <h2 className="text-lg font-semibold text-foreground">
            Authorized accounts
          </h2>
          <p className="mt-1 text-sm text-muted">
            Pending accounts become active after the user creates an account
            with the authorized email address.
          </p>
          <div className="mt-5 grid gap-3">
            {(invitations ?? []).map((invitation) => (
              <article
                key={invitation._id}
                className="flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium text-foreground">
                    {invitation.name ?? invitation.email}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {invitation.email} · {roleLabel(invitation.role)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill
                    tone={
                      invitation.status === "accepted"
                        ? "success"
                        : invitation.status === "revoked"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {invitation.status}
                  </StatusPill>
                  {invitation.role !== "super_admin" &&
                  invitation.status !== "revoked" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => void revokeAccess(invitation._id)}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
