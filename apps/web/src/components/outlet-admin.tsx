"use client";

import { Button } from "@heroui/react";
import {
  Card,
  FormField,
  Pager,
  ListRow,
  StatusPill,
  WorkspaceIcon,
} from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState, type FormEvent } from "react";
import { formatManilaDate, futureManilaDateToUtcMs } from "../lib/manila-date";

type Action =
  | "create"
  | "edit"
  | "link"
  | "deactivate"
  | "propose"
  | "verified"
  | "rejected";
type Actions = {
  create: (
    args: FunctionArgs<typeof api.outlets.mutations.create>,
  ) => Promise<unknown>;
  edit: (
    args: FunctionArgs<typeof api.outlets.mutations.edit>,
  ) => Promise<unknown>;
  link: (
    args: FunctionArgs<typeof api.outlets.mutations.changeCustomerLink>,
  ) => Promise<unknown>;
  deactivate: (
    args: FunctionArgs<typeof api.outlets.mutations.deactivate>,
  ) => Promise<unknown>;
  propose: (
    args: FunctionArgs<typeof api.outlets.verification.propose>,
  ) => Promise<unknown>;
  decide: (
    args: FunctionArgs<typeof api.outlets.verification.decide>,
  ) => Promise<unknown>;
};
const text = (data: Pick<FormData, "get">, key: string) =>
  String(data.get(key) ?? "").trim();
const optional = (data: Pick<FormData, "get">, key: string) =>
  text(data, key) || undefined;
const number = (data: Pick<FormData, "get">, key: string) =>
  optional(data, key) ? Number(text(data, key)) : undefined;

/** Conversion boundary shared by the profile and verification forms. */
export async function performOutletAction(
  action: Action,
  data: Pick<FormData, "get">,
  actions: Actions,
  outletId?: Id<"outlets">,
  pinId?: Id<"outletPins">,
) {
  const reason = text(data, "reason");
  if (!reason) throw new Error("Reason required");
  if (action === "create" || action === "edit") {
    const profile = {
      name: text(data, "name"),
      status: text(data, "status") as "prospect" | "active",
      channel: optional(data, "channel"),
      subchannel: optional(data, "subchannel"),
      classification: optional(data, "classification"),
      address: optional(data, "address"),
      directions: optional(data, "directions"),
      salesPotential: number(data, "salesPotential"),
      preferredWeekday: number(data, "preferredWeekday"),
      visitFrequencyDays: number(data, "visitFrequencyDays"),
      visitWindow: optional(data, "visitWindow"),
      contacts: text(data, "contactName")
        ? [
            {
              name: text(data, "contactName"),
              phone: optional(data, "contactPhone"),
            },
          ]
        : [],
      reason,
    };
    if (action === "create")
      return actions.create({
        ...profile,
        code: text(data, "code"),
        custodianOrgUnitId: text(data, "custodianOrgUnitId") as Id<"orgUnits">,
      });
    if (!outletId) throw new Error("Select an outlet");
    return actions.edit({ ...profile, outletId });
  }
  if (!outletId) throw new Error("Select an outlet");
  if (action === "link")
    return actions.link({
      outletId,
      customerId: optional(data, "customerId") as Id<"customers"> | undefined,
      effectiveFrom: futureManilaDateToUtcMs(text(data, "effectiveDate")),
      source: text(data, "source"),
      reason,
    });
  if (action === "deactivate") return actions.deactivate({ outletId, reason });
  if (action === "propose")
    return actions.propose({
      outletId,
      latitude: Number(text(data, "latitude")),
      longitude: Number(text(data, "longitude")),
      radiusMeters: number(data, "radiusMeters"),
      source: text(data, "source"),
      evidenceNote: optional(data, "evidenceNote"),
      effectiveFrom: optional(data, "effectiveDate")
        ? futureManilaDateToUtcMs(text(data, "effectiveDate"))
        : undefined,
      reason,
    });
  if (!pinId) throw new Error("Select a pending pin");
  return actions.decide({ pinId, decision: action, reason });
}

export function OutletAdmin() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const profile = useQuery(api.domains.profiles.current, {});
  const canRead = permissions?.capabilities.includes("outlet.read") ?? false;
  const canManage =
    permissions?.capabilities.includes("outlet.manage") ?? false;
  const canVerify =
    permissions?.capabilities.includes("outlet.verify") ?? false;
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const list = useQuery(
    api.outlets.queries.list,
    canRead
      ? { paginationOpts: { cursor: cursors.at(-1) ?? null, numItems: 25 } }
      : "skip",
  );
  const [selectedId, setSelectedId] = useState<Id<"outlets"> | null>(null);
  const detail = useQuery(
    api.outlets.queries.detail,
    canRead && selectedId ? { outletId: selectedId } : "skip",
  );
  const links = useQuery(
    api.outlets.queries.customerHistory,
    canRead && selectedId ? { outletId: selectedId } : "skip",
  );
  const pins = useQuery(
    api.outlets.queries.pinHistory,
    canRead && selectedId ? { outletId: selectedId } : "skip",
  );
  const [asOf] = useState(() => Date.now());
  const units = useQuery(api.org.queries.tree, canManage ? { asOf } : "skip");
  const customers = useQuery(
    api.domains.masterData.customers,
    canManage ? { limit: 100 } : "skip",
  );
  const create = useMutation(api.outlets.mutations.create);
  const edit = useMutation(api.outlets.mutations.edit);
  const link = useMutation(api.outlets.mutations.changeCustomerLink);
  const deactivate = useMutation(api.outlets.mutations.deactivate);
  const propose = useMutation(api.outlets.verification.propose);
  const decide = useMutation(api.outlets.verification.decide);
  const [action, setAction] = useState<Action | null>(null);
  const [pendingPin, setPendingPin] = useState<Id<"outletPins"> | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || pending) return;
    setError("");
    setNotice("");
    setPending(true);
    try {
      await performOutletAction(
        action,
        new FormData(event.currentTarget),
        { create, edit, link, deactivate, propose, decide },
        selectedId ?? undefined,
        pendingPin ?? undefined,
      );
      setNotice("Outlet change saved. History remains available.");
      setAction(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  const customerName = (id: Id<"customers">) =>
    customers?.find((c) => c._id === id)?.name ?? id;
  return (
    <Card
      label="Outlets"
      count={list?.page.length}
      icon={<WorkspaceIcon name="field" />}
      actions={
        canManage ? (
          <Button
            variant="outline"
            className="h-8"
            onPress={() => setAction("create")}
          >
            Create outlet
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-4">
        {list === undefined ? (
          <p>Loading outlets…</p>
        ) : (
          <ul
            aria-label="Outlet list"
            className="overflow-hidden rounded-xl border border-border"
          >
            {list.page.map((row) => (
              <li key={row._id}>
                <ListRow
                  icon={<WorkspaceIcon name="field" />}
                  title={row.name}
                  meta={row.code}
                  value={
                    row.status !== "active" ? (
                      <StatusPill tone="neutral">{row.status}</StatusPill>
                    ) : undefined
                  }
                  action={
                    <Button
                      variant="outline"
                      className="h-8"
                      onPress={() => {
                        setSelectedId(row._id);
                        setAction(null);
                      }}
                    >
                      Open
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )}
        <Pager
          page={cursors.length}
          canPrevious={cursors.length > 1}
          canNext={!!list && !list.isDone}
          onPrevious={() => setCursors((old) => old.slice(0, -1))}
          onNext={() => {
            if (list && !list.isDone)
              setCursors((old) => [...old, list.continueCursor]);
          }}
          label="Outlets pages"
        />
        {detail && (
          <section
            aria-label="Outlet profile"
            className="grid gap-2 rounded border border-border p-3"
          >
            <h3>
              {detail.outlet.name} · {detail.outlet.code}
            </h3>
            <p>
              {detail.outlet.status[0]?.toUpperCase()}
              {detail.outlet.status.slice(1)} ·{" "}
              {detail.outlet.channel ?? "Channel not set"} ·{" "}
              {detail.outlet.address ?? "Address not set"}
            </p>
            <p>
              Customer:{" "}
              {detail.customerLink
                ? customerName(detail.customerLink.customerId)
                : "Unlinked prospect / site"}
            </p>
            <p>
              Route:{" "}
              {detail.assignment
                ? `${detail.assignment.territoryId} / ${detail.assignment.routeId ?? "no route"}${detail.assignment.sequence ? ` · stop ${detail.assignment.sequence}` : ""}`
                : "Unassigned"}
            </p>
            <p>
              Verified pin:{" "}
              {detail.pin
                ? `${detail.pin.latitude}, ${detail.pin.longitude} · ${detail.pin.radiusMeters} m`
                : "None"}
            </p>
            {canManage && (
              <div className="flex gap-2">
                <button type="button" onClick={() => setAction("edit")}>
                  Edit profile
                </button>
                <button type="button" onClick={() => setAction("link")}>
                  Change customer link
                </button>
                <button type="button" onClick={() => setAction("deactivate")}>
                  Deactivate
                </button>
              </div>
            )}
            <h4>Customer history</h4>
            <ul>
              {links?.map((row) => (
                <li key={row._id}>
                  {customerName(row.customerId)} · {row.source} ·{" "}
                  {formatManilaDate(row.effectiveFrom)}–
                  {row.effectiveTo
                    ? formatManilaDate(row.effectiveTo)
                    : "Current"}{" "}
                  · {row.reason}
                </li>
              ))}
            </ul>
            <h4>Verification</h4>
            {canManage && (
              <button type="button" onClick={() => setAction("propose")}>
                Propose GPS pin
              </button>
            )}
            <ul>
              {pins?.map((pin) => (
                <li key={pin._id}>
                  {pin.status[0]?.toUpperCase()}
                  {pin.status.slice(1)} · {pin.latitude}, {pin.longitude} ·{" "}
                  {pin.radiusMeters} m · {pin.source} ·{" "}
                  {pin.evidenceNote ?? "No note"} · proposed by {pin.proposedBy}
                  {pin.verifiedBy && (
                    <>
                      {" "}
                      · reviewed by {pin.verifiedBy}: {pin.reviewerReason}
                    </>
                  )}
                  {pin.status === "verified" && (
                    <>
                      {" "}
                      · {formatManilaDate(pin.effectiveFrom)}–
                      {pin.effectiveTo
                        ? formatManilaDate(pin.effectiveTo)
                        : "Current"}
                    </>
                  )}
                  {pin.status === "pending" && canVerify && (
                    <>
                      <button
                        type="button"
                        disabled={
                          !profile || profile.authSubject === pin.proposedBy
                        }
                        onClick={() => {
                          setPendingPin(pin._id);
                          setAction("verified");
                        }}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={
                          !profile || profile.authSubject === pin.proposedBy
                        }
                        onClick={() => {
                          setPendingPin(pin._id);
                          setAction("rejected");
                        }}
                      >
                        Reject
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {action && (
          <form
            key={`${action}-${selectedId}`}
            onSubmit={submit}
            className="grid gap-3 rounded border border-border p-3 sm:grid-cols-2 lg:grid-cols-3"
            aria-label="Outlet action"
          >
            <h3>
              {action === "create"
                ? "Create outlet"
                : action === "edit"
                  ? "Edit profile"
                  : action === "link"
                    ? "Change customer link"
                    : action === "propose"
                      ? "Propose GPS pin"
                      : action === "deactivate"
                        ? "Deactivate outlet"
                        : `${action === "verified" ? "Approve" : "Reject"} pin`}
            </h3>
            {(action === "create" || action === "edit") && (
              <>
                {action === "create" && (
                  <>
                    <FormField label="Code">
                      <input name="code" required />
                    </FormField>
                    <FormField label="Custodian unit">
                      <select name="custodianOrgUnitId" required>
                        <option value="">Select unit</option>
                        {units
                          ?.filter((u) => u.status === "active")
                          .map((u) => (
                            <option key={u._id} value={u._id}>
                              {u.name}
                            </option>
                          ))}
                      </select>
                    </FormField>
                  </>
                )}
                <FormField label="Name">
                  <input
                    name="name"
                    defaultValue={detail?.outlet.name}
                    required
                  />
                </FormField>
                <FormField label="Site status">
                  <select
                    name="status"
                    defaultValue={detail?.outlet.status ?? "prospect"}
                  >
                    <option value="prospect">Prospect / unlinked</option>
                    <option value="active">Active</option>
                  </select>
                </FormField>
                {(
                  [
                    "channel",
                    "subchannel",
                    "classification",
                    "address",
                    "directions",
                    "visitWindow",
                  ] as const
                ).map((key) => (
                  <FormField key={key} label={key}>
                    <input name={key} defaultValue={detail?.outlet[key]} />
                  </FormField>
                ))}
                <FormField label="Contact name">
                  <input
                    name="contactName"
                    defaultValue={detail?.outlet.contacts?.[0]?.name}
                  />
                </FormField>
                <FormField label="Contact phone">
                  <input
                    name="contactPhone"
                    defaultValue={detail?.outlet.contacts?.[0]?.phone}
                  />
                </FormField>
                <FormField label="Sales potential">
                  <input
                    type="number"
                    min="0"
                    name="salesPotential"
                    defaultValue={detail?.outlet.salesPotential}
                  />
                </FormField>
                <FormField label="Preferred weekday (0–6)">
                  <input
                    type="number"
                    min="0"
                    max="6"
                    name="preferredWeekday"
                    defaultValue={detail?.outlet.preferredWeekday}
                  />
                </FormField>
                <FormField label="Visit frequency (days)">
                  <input
                    type="number"
                    min="1"
                    max="365"
                    name="visitFrequencyDays"
                    defaultValue={detail?.outlet.visitFrequencyDays}
                  />
                </FormField>
              </>
            )}
            {action === "link" && (
              <>
                <FormField label="Existing customer">
                  <select name="customerId">
                    <option value="">Unlink (prospect)</option>
                    {customers
                      ?.filter((c) => c.active)
                      .map((c) => (
                        <option key={c._id} value={c._id}>
                          {c.name} · {c.code}
                        </option>
                      ))}
                  </select>
                </FormField>
                <FormField label="Source">
                  <input name="source" defaultValue="local" required />
                </FormField>
                <FormField label="Effective date">
                  <input type="date" name="effectiveDate" required />
                </FormField>
              </>
            )}
            {action === "propose" && (
              <>
                <FormField label="Latitude">
                  <input name="latitude" type="number" step="any" required />
                </FormField>
                <FormField label="Longitude">
                  <input name="longitude" type="number" step="any" required />
                </FormField>
                <FormField label="Radius meters (default 75)">
                  <input name="radiusMeters" type="number" min="1" max="500" />
                </FormField>
                <FormField label="Source">
                  <input name="source" required />
                </FormField>
                <FormField label="Evidence note">
                  <input name="evidenceNote" />
                </FormField>
                <FormField label="Future effective date (optional)">
                  <input name="effectiveDate" type="date" />
                </FormField>
              </>
            )}
            <FormField label="Reason">
              <input name="reason" required />
            </FormField>
            <button type="submit" disabled={pending}>
              Save {action}
            </button>
            <button type="button" onClick={() => setAction(null)}>
              Cancel
            </button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </Card>
  );
}
