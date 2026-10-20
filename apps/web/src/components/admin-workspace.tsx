"use client";

import { Button, Input } from "@heroui/react";
import { api } from "./master-data/api";
import type { Id } from "./master-data/model";
import {
  Card,
  FormField,
  ListRow,
  Notice,
  StatusPill,
  Pager,
  UnderlineTabs,
  WorkspaceIcon,
} from "@sunpride/ui";
import { useMutation, useQuery } from "./master-data/api";
import { useState, type FormEvent } from "react";
import { AdminSelectField, OrgAdmin } from "./org-admin";
import { TerritoryAdmin } from "./territory-admin";
import { RouteAdmin } from "./route-admin";
import { OutletAdmin } from "./outlet-admin";
import { OutletAssignments } from "./outlet-assignments";
import {
  PeopleAdmin,
  roleLabel,
  roleOptions,
  type AssignableRole,
} from "./people-admin";
import { TeamsAdmin } from "./teams-admin";
import { DevicesAdmin } from "./devices-admin";
import { CallFlowAdmin } from "./callflow-admin";
import { MastersWorkspace } from "./spec-masters/workspace";
import { SetupHealth, SetupSearch } from "./master-data/setup-health";
import { setSetupParam, useSetupParam } from "./master-data/location";

const readableError = (error: unknown) =>
  error instanceof Error ? error.message : "Access update failed. Try again.";

const tabs = [
  ["health", "Setup health"],
  ["organization", "Organization"],
  ["people", "People"],
  ["teams", "Teams"],
  ["invitations", "Invitations"],
  ["territories", "Territories"],
  ["routes", "Routes"],
  ["outlets", "Outlets"],
  ["assignments", "Assignments"],
  ["devices", "Phones"],
  ["callflow", "Call flows"],
  ["field-masters", "Field masters"],
] as const;
type AdminTab = (typeof tabs)[number][0];

export function AdminWorkspace() {
  const [tab, setTab] = useState<AdminTab>("health");
  const section = useSetupParam("section");
  const activeTab = (
    tabs.some(([id]) => id === section) ? section : tab
  ) as AdminTab;
  return (
    <div className="grid gap-4">
      <UnderlineTabs
        label="Administration sections"
        items={tabs}
        activeId={activeTab}
        onChange={(value) => {
          setTab(value);
          setSetupParam("section", value);
        }}
      />
      {activeTab === "health" ? (
        <SetupHealth />
      ) : activeTab === "organization" ? (
        <OrgAdmin />
      ) : activeTab === "people" ? (
        <PeopleAdmin />
      ) : activeTab === "teams" ? (
        <TeamsAdmin />
      ) : activeTab === "territories" ? (
        <TerritoryAdmin />
      ) : activeTab === "routes" ? (
        <RouteAdmin />
      ) : activeTab === "outlets" ? (
        <OutletAdmin />
      ) : activeTab === "assignments" ? (
        <OutletAssignments />
      ) : activeTab === "callflow" ? (
        <CallFlowAdmin />
      ) : activeTab === "field-masters" ? (
        <MastersWorkspace />
      ) : activeTab === "devices" ? (
        <DevicesAdmin />
      ) : (
        <InvitationsAdmin />
      )}
    </div>
  );
}

function InvitationsAdmin() {
  const [search, setSearch] = useState<string | undefined>(undefined);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const current = useQuery(api.domains.profiles.current, {});
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const canAdminister =
    (current?.role === "super_admin" || current?.role === "admin") &&
    permissions?.national !== false;
  const invitationPage = useQuery(
    api.domains.profiles.listInvitations,
    canAdminister
      ? {
          q: search,
          paginationOpts: { numItems: 25, cursor: cursors.at(-1) ?? null },
        }
      : "skip",
  );
  const invitations = invitationPage?.page;
  const units = useQuery(api.org.queries.tree, canAdminister ? {} : "skip");
  const invite = useMutation(api.domains.profiles.invite);
  const revoke = useMutation(api.domains.profiles.revoke);
  const positions = useQuery(
    api.sfa.positions.list,
    canAdminister ? {} : "skip",
  );
  const [role, setRole] = useState<AssignableRole>("viewer");
  const [positionId, setPositionId] = useState("");
  const [orgUnitId, setOrgUnitId] = useState("");
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
        ...(orgUnitId ? { orgUnitId } : {}),
      });
      setMessage({ tone: "success", text: "Invitation sent" });
      form.reset();
      setRole("viewer");
      setPositionId("");
      setOrgUnitId("");
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
        <SetupSearch
          label="Search invitations"
          value={search ?? ""}
          onChange={(value) => {
            setSearch(value);
            setCursors([null]);
          }}
        />
        {(invitations ?? []).length ? (
          invitations?.map((invitation) => (
            <ListRow
              key={invitation._id}
              icon={<WorkspaceIcon name="user" />}
              title={invitation.name?.trim() || invitation.email}
              meta={[
                ...(invitation.name?.trim() ? [invitation.email] : []),
                roleLabel(invitation.role),
              ].join(" · ")}
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
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 whitespace-nowrap"
                  isDisabled={
                    invitation.role === "super_admin" ||
                    invitation.status === "revoked"
                  }
                  onPress={() => void revokeAccess(invitation._id)}
                >
                  Revoke access
                </Button>
              }
            />
          ))
        ) : (
          <p className="p-4 text-[13px] text-muted">No invitations</p>
        )}
        <Pager
          label="Invitation pages"
          page={cursors.length}
          canPrevious={cursors.length > 1}
          canNext={!!invitationPage && !invitationPage.isDone}
          onPrevious={() => setCursors((old) => old.slice(0, -1))}
          onNext={() =>
            invitationPage &&
            setCursors((old) => [...old, invitationPage.continueCursor])
          }
        />
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
          <FormField label="Full name">
            <Input name="name" placeholder="Juan Dela Cruz" />
          </FormField>
          <FormField label="Email">
            <Input
              name="email"
              type="email"
              required
              placeholder="name@sunpride.com.ph"
            />
          </FormField>
          <AdminSelectField
            label="Role"
            value={role}
            onChange={(value) => setRole(value as AssignableRole)}
            options={roleOptions
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
          <AdminSelectField
            label="Organizational unit"
            value={orgUnitId}
            onChange={setOrgUnitId}
            options={[
              { id: "", label: "Assign later" },
              ...(units ?? [])
                .filter((u) => u.status === "active")
                .map((u) => ({ id: u._id, label: `${u.code} · ${u.name}` })),
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
