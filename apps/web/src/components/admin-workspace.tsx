"use client";

import { Button, Input } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { StatusPill } from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";

type AssignableRole =
  | "admin"
  | "operations"
  | "manager"
  | "approver"
  | "sales"
  | "analyst"
  | "viewer";

const roles: { value: AssignableRole; label: string }[] = [
  { value: "admin", label: "Administrator" },
  { value: "operations", label: "Operations" },
  { value: "manager", label: "Sales manager" },
  { value: "approver", label: "Approver" },
  { value: "sales", label: "Sales" },
  { value: "analyst", label: "Analyst (read-only, all areas)" },
  { value: "viewer", label: "Viewer (read-only, own area)" },
];

const roleLabel = (role: string) => {
  const known = roles.find((option) => option.value === role);
  if (known) return known.label;
  return role
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

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
  const assignPersona = useMutation(api.domains.profiles.assignPersona);
  const positions = useQuery(
    api.sfa.positions.list,
    canAdminister ? {} : "skip",
  );
  const orgUnits = useQuery(
    api.domains.profiles.listAssignableOrgUnits,
    canAdminister ? {} : "skip",
  );
  const [role, setRole] = useState<AssignableRole>("viewer");
  const [positionId, setPositionId] = useState("");
  const [pending, setPending] = useState(false);
  const [assignments, setAssignments] = useState<
    Record<string, { positionId: string; orgUnitId: string }>
  >({});
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
      await invite({
        email,
        role,
        ...(name ? { name } : {}),
        ...(positionId ? { positionId: positionId as Id<"positions"> } : {}),
      });
      setMessage({
        tone: "success",
        text: `${email.toLowerCase()} can now create an account and sign in.`,
      });
      form.reset();
      setRole("viewer");
      setPositionId("");
    } catch (error) {
      setMessage({ tone: "error", text: readableError(error) });
    } finally {
      setPending(false);
    }
  }

  const positionLabel = (id: string | undefined) =>
    (positions ?? []).find((position) => position._id === id)?.label ??
    "No position set";

  const assignmentFor = (
    profileId: string,
    fallback?: { positionId?: string; orgUnitId?: string },
  ) =>
    assignments[profileId] ?? {
      positionId: fallback?.positionId ?? "",
      orgUnitId: fallback?.orgUnitId ?? "",
    };

  const setAssignment = (
    profileId: string,
    patch: Partial<{ positionId: string; orgUnitId: string }>,
    fallback?: { positionId?: string; orgUnitId?: string },
  ) =>
    setAssignments((current) => ({
      ...current,
      [profileId]: { ...assignmentFor(profileId, fallback), ...patch },
    }));

  async function savePersona(
    profileId: Id<"profiles">,
    fallback?: { positionId?: string; orgUnitId?: string },
  ) {
    const choice = assignmentFor(profileId, fallback);
    setMessage(null);
    try {
      await assignPersona({
        profileId,
        ...(choice.positionId
          ? { positionId: choice.positionId as Id<"positions"> }
          : {}),
        ...(choice.orgUnitId
          ? { orgUnitId: choice.orgUnitId as Id<"orgUnits"> }
          : {}),
      });
      setMessage({ tone: "success", text: "Position and area updated." });
    } catch (error) {
      setMessage({ tone: "error", text: readableError(error) });
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
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            Position (optional)
            <select
              value={positionId}
              onChange={(event) => setPositionId(event.target.value)}
              className="h-10 rounded-md border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
            >
              <option value="">No position set</option>
              {(positions ?? []).map((position) => (
                <option key={position._id} value={position._id}>
                  {position.label}
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
            {(profiles ?? []).map((profile) => {
              const persona = {
                ...(profile.positionId
                  ? { positionId: profile.positionId }
                  : {}),
                ...(profile.orgUnitId ? { orgUnitId: profile.orgUnitId } : {}),
              };
              const choice = assignmentFor(profile._id, persona);
              return (
                <article
                  key={profile._id}
                  className="grid gap-3 rounded-md border border-border p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-medium text-foreground">
                        {profile.name}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {profile.email} · {positionLabel(profile.positionId)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill
                        tone={
                          profile.status === "active" ? "success" : "neutral"
                        }
                      >
                        {profile.status}
                      </StatusPill>
                      <StatusPill
                        tone={
                          profile.role === "super_admin" ? "danger" : "neutral"
                        }
                      >
                        {roleLabel(profile.role)}
                      </StatusPill>
                    </div>
                  </div>
                  {profile.role !== "super_admin" ? (
                    <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
                      <label className="grid gap-1.5 text-xs font-medium text-muted">
                        Position
                        <select
                          value={choice.positionId}
                          onChange={(event) =>
                            setAssignment(
                              profile._id,
                              { positionId: event.target.value },
                              persona,
                            )
                          }
                          className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-foreground outline-none focus:border-accent"
                        >
                          <option value="">No position set</option>
                          {(positions ?? []).map((position) => (
                            <option key={position._id} value={position._id}>
                              {position.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="grid gap-1.5 text-xs font-medium text-muted">
                        Area
                        <select
                          value={choice.orgUnitId}
                          onChange={(event) =>
                            setAssignment(
                              profile._id,
                              { orgUnitId: event.target.value },
                              persona,
                            )
                          }
                          className="h-9 rounded-md border border-border bg-surface px-2 text-sm text-foreground outline-none focus:border-accent"
                        >
                          <option value="">Keep current area</option>
                          {(orgUnits ?? []).map((unit) => (
                            <option key={unit._id} value={unit._id}>
                              {unit.code} · {unit.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => void savePersona(profile._id, persona)}
                      >
                        Save
                      </Button>
                    </div>
                  ) : null}
                </article>
              );
            })}
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
