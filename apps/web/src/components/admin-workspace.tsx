"use client";

import { Button, Input, Label, TextField } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  ListRow,
  Notice,
  StatusPill,
  UnderlineTabs,
  WorkspaceIcon,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { AdminSelectField, OrgAdmin } from "./org-admin";
import { TerritoryAdmin } from "./territory-admin";
import { RouteAdmin } from "./route-admin";
import { OutletAdmin } from "./outlet-admin";
import { OutletAssignments } from "./outlet-assignments";
import { PeopleAdmin } from "./people-admin";
import { TeamsAdmin } from "./teams-admin";

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
  { value: "analyst", label: "Analyst" },
  { value: "viewer", label: "Viewer" },
];

const roleLabel = (role: string) =>
  roles.find((option) => option.value === role)?.label ??
  role.replaceAll("_", " ");

const readableError = (error: unknown) =>
  error instanceof Error ? error.message : "Access update failed. Try again.";

const tabs = [
  ["organization", "Organization"],
  ["people", "People"],
  ["teams", "Teams"],
  ["invitations", "Invitations"],
  ["territories", "Territories"],
  ["routes", "Routes"],
  ["outlets", "Outlets"],
  ["assignments", "Assignments"],
] as const;
type AdminTab = (typeof tabs)[number][0];

export function AdminWorkspace() {
  const [tab, setTab] = useState<AdminTab>("organization");
  const people = useQuery(api.people.queries.list, {
    paginationOpts: { numItems: 25, cursor: null },
  });
  const teams = useQuery(api.teams.queries.list, {
    paginationOpts: { numItems: 25, cursor: null },
  });
  return (
    <div className="grid gap-4">
      {people && teams ? (
        <p className="text-[13px] text-muted">
          {people.page.length} people shown · {teams.page.length} teams shown
        </p>
      ) : null}
      <UnderlineTabs
        label="Administration sections"
        items={tabs}
        activeId={tab}
        onChange={setTab}
      />
      {tab === "organization" ? (
        <OrgAdmin />
      ) : tab === "people" ? (
        <PeopleAdmin />
      ) : tab === "teams" ? (
        <TeamsAdmin />
      ) : tab === "territories" ? (
        <TerritoryAdmin />
      ) : tab === "routes" ? (
        <RouteAdmin />
      ) : tab === "outlets" ? (
        <OutletAdmin />
      ) : tab === "assignments" ? (
        <OutletAssignments />
      ) : (
        <InvitationsAdmin />
      )}
    </div>
  );
}

function InvitationsAdmin() {
  const current = useQuery(api.domains.profiles.current, {});
  const canAdminister =
    current?.role === "super_admin" || current?.role === "admin";
  const invitations = useQuery(
    api.domains.profiles.listInvitations,
    canAdminister ? {} : "skip",
  );
  const invite = useMutation(api.domains.profiles.invite);
  const revoke = useMutation(api.domains.profiles.revoke);
  const positions = useQuery(
    api.sfa.positions.list,
    canAdminister ? {} : "skip",
  );
  const [role, setRole] = useState<AssignableRole>("viewer");
  const [positionId, setPositionId] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);

  if (!current) return <Card label="Invitations">Loading access…</Card>;
  if (!canAdminister)
    return (
      <Card label="Invitations">
        <Notice title="Administrator access required" tone="warning" />
      </Card>
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
      setMessage({ tone: "success", text: "Invitation sent" });
      form.reset();
      setRole("viewer");
      setPositionId("");
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
      setMessage({ tone: "success", text: "Access revoked" });
    } catch (error) {
      setMessage({ tone: "error", text: readableError(error) });
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card
        label="Invitations"
        count={invitations?.length}
        icon={<WorkspaceIcon name="user" />}
        flush
      >
        {(invitations ?? []).length ? (
          invitations?.map((invitation) => (
            <ListRow
              key={invitation._id}
              icon={<WorkspaceIcon name="user" />}
              title={invitation.name ?? invitation.email}
              meta={`${invitation.email} · ${roleLabel(invitation.role)}`}
              value={
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
              }
              action={
                invitation.role !== "super_admin" &&
                invitation.status !== "revoked" ? (
                  <Button
                    size="sm"
                    variant="danger-soft"
                    onPress={() => void revokeAccess(invitation._id)}
                  >
                    Revoke access
                  </Button>
                ) : undefined
              }
            />
          ))
        ) : (
          <p className="p-4 text-[13px] text-muted">No invitations</p>
        )}
      </Card>
      <Card
        label="Invite person"
        icon={<WorkspaceIcon name="user" />}
        actions={
          <Button
            type="submit"
            form="invite-person"
            variant="primary"
            isPending={pending}
            className="h-10 rounded-[10px]"
          >
            Send invitation
          </Button>
        }
      >
        <form id="invite-person" onSubmit={submit} className="grid gap-4">
          <TextField name="name" className="grid gap-1.5">
            <Label className="text-[13px] font-medium">Full name</Label>
            <Input
              className="h-10 rounded-[10px] border border-border bg-surface px-3 text-sm shadow-none"
              placeholder="Juan Dela Cruz"
            />
          </TextField>
          <TextField
            name="email"
            type="email"
            isRequired
            className="grid gap-1.5"
          >
            <Label className="text-[13px] font-medium">Email</Label>
            <Input
              className="h-10 rounded-[10px] border border-border bg-surface px-3 text-sm shadow-none"
              placeholder="name@sunpride.com.ph"
            />
          </TextField>
          <AdminSelectField
            label="Role"
            value={role}
            onChange={(value) => setRole(value as AssignableRole)}
            options={roles
              .filter(
                (option) =>
                  option.value !== "admin" || current.role === "super_admin",
              )
              .map((option) => ({ id: option.value, label: option.label }))}
          />
          <AdminSelectField
            label="Position"
            value={positionId}
            onChange={setPositionId}
            options={[
              { id: "", label: "No position" },
              ...(positions ?? []).map((position) => ({
                id: position._id,
                label: position.label,
              })),
            ]}
          />
          {message ? (
            <p
              role="status"
              className={`rounded-xl p-3 text-sm ${message.tone === "success" ? "bg-success-soft text-success-soft-foreground" : "bg-danger-soft text-danger-soft-foreground"}`}
            >
              {message.text}
            </p>
          ) : null}
        </form>
      </Card>
    </div>
  );
}
