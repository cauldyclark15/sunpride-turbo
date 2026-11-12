"use client";

import Link from "next/link";
import { FormField, StatusPill } from "@sunpride/ui";
import { api } from "./master-data/api";
import type { Id } from "./master-data/model";
import { useMutation, useQuery } from "./master-data/api";
import type { FunctionArgs } from "./master-data/api";
import { useState, type FormEvent } from "react";
import { formatManilaDate, futureManilaDateToUtcMs } from "../lib/manila-date";
import { useSetupParam } from "./master-data/location";

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
    // A phone needs a contact name (the API stores contacts by name); dropping the typed phone
    // silently looked like a successful save (WEB-170).
    if (optional(data, "contactPhone") && !text(data, "contactName"))
      throw new Error("Add the contact name for this phone.");
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
    if (!outletId) throw new Error("Pick a store first");
    return actions.edit({ ...profile, outletId });
  }
  if (!outletId) throw new Error("Pick a store first");
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
  if (!pinId) throw new Error("Pick a pending pin first");
  return actions.decide({ pinId, decision: action, reason });
}

const btn =
  "inline-flex h-9 items-center rounded-lg border border-border px-3 text-[13px] font-medium text-foreground hover:bg-default-soft disabled:opacity-50";
const primaryBtn =
  "inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-[14px] font-semibold text-background hover:opacity-90 disabled:opacity-50";

const TITLES: Record<Action, string> = {
  create: "Add store",
  edit: "Edit store",
  link: "Edit customer link",
  propose: "Add GPS pin",
  deactivate: "Deactivate store",
  verified: "Approve pin",
  rejected: "Reject pin",
};

/** Setup › Outlets now points at the one store list; a drill link (?outlet=) still opens that store's editor. */
export function OutletAdmin() {
  const requestedOutlet = useSetupParam("outlet");
  return (
    <div className="grid gap-4">
      <p className="text-[14px] text-muted">
        Customers are added and edited on the Customers page.{" "}
        <Link
          href={
            requestedOutlet
              ? `/customers?edit=${encodeURIComponent(requestedOutlet)}`
              : "/customers"
          }
          className="font-medium text-foreground underline"
        >
          Open Customers
        </Link>
      </p>
      {requestedOutlet ? (
        <OutletEditor outletId={requestedOutlet as Id<"outlets">} />
      ) : null}
    </div>
  );
}

/** One store's profile with Edit, customer link, GPS pin and deactivate. Used in the Stores list Edit sheet. */
export function OutletEditor({
  outletId,
  onDone,
}: {
  outletId: Id<"outlets">;
  onDone?: () => void;
}) {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const profile = useQuery(api.domains.profiles.current, {});
  const canRead = permissions?.capabilities.includes("outlet.read") ?? false;
  const canManage =
    permissions?.capabilities.includes("outlet.manage") ?? false;
  const canVerify =
    permissions?.capabilities.includes("outlet.verify") ?? false;
  const detail = useQuery(
    api.outlets.queries.detail,
    canRead ? { outletId } : "skip",
  );
  const links = useQuery(
    api.outlets.queries.customerHistory,
    canRead ? { outletId } : "skip",
  );
  const pins = useQuery(
    api.outlets.queries.pinHistory,
    canRead ? { outletId } : "skip",
  );
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
  const [pendingPin, setPendingPin] = useState<Id<"outletPins"> | null>(null);
  const [action, setAction] = useState<Action | null>(null);
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
        outletId,
        pendingPin ?? undefined,
      );
      setNotice("Saved.");
      setAction(null);
      if (action === "edit" || action === "deactivate") onDone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  const customerName = (id: Id<"customers">) =>
    customers?.page.find((c) => c._id === id)?.name ?? "Linked customer";
  if (!canRead) return null;
  if (detail === undefined)
    return <p className="text-[14px] text-muted">Loading store…</p>;
  if (!detail)
    return <p className="text-[14px] text-muted">Store not found.</p>;
  return (
    <div className="grid gap-4">
      <section aria-label="Outlet profile" className="grid gap-2">
        <h3 className="text-[17px] font-semibold text-foreground">
          {detail.outlet.name} · {detail.outlet.code}
        </h3>
        {detail.outlet.enrolmentStatus === "provisional" && (
          <p className="text-[14px]">
            <StatusPill tone="warning">Provisional</StatusPill> Waiting for
            approval; the customer code is given on approval.
          </p>
        )}
        <p className="text-[14px] text-muted">
          {detail.outlet.status[0]?.toUpperCase()}
          {detail.outlet.status.slice(1)} ·{" "}
          {detail.outlet.channel ?? "No channel"} ·{" "}
          {detail.outlet.address ?? "No address"}
        </p>
        <p className="text-[14px] text-muted">
          Customer:{" "}
          {detail.customerLink
            ? customerName(detail.customerLink.customerId)
            : "Not linked yet"}
          {" · "}Route:{" "}
          {detail.assignment
            ? `${detail.outlet.territoryName ?? "Area set"} / ${detail.outlet.routeName ?? "no route"}${detail.assignment.sequence ? ` · stop ${detail.assignment.sequence}` : ""}`
            : "None"}
          {" · "}GPS:{" "}
          {detail.pin
            ? `${detail.pin.latitude}, ${detail.pin.longitude} · ${detail.pin.radiusMeters} m`
            : "None"}
        </p>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btn}
              onClick={() => setAction("edit")}
            >
              Edit store
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => setAction("link")}
            >
              Edit customer link
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => setAction("propose")}
            >
              Add GPS pin
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => setAction("deactivate")}
            >
              Deactivate
            </button>
          </div>
        )}
      </section>
      {action && (
        <form
          key={`${action}-${outletId}`}
          onSubmit={submit}
          className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-2"
          aria-label="Outlet action"
        >
          <h3 className="font-semibold sm:col-span-2">{TITLES[action]}</h3>
          {action === "edit" && (
            <>
              <FormField label="Name">
                <input name="name" defaultValue={detail.outlet.name} required />
              </FormField>
              <FormField label="Status">
                <select
                  name="status"
                  defaultValue={detail.outlet.status ?? "prospect"}
                >
                  <option value="prospect">Not buying yet</option>
                  <option value="active">Active</option>
                </select>
              </FormField>
              {(
                [
                  ["channel", "Channel"],
                  ["subchannel", "Subchannel"],
                  ["classification", "Class"],
                  ["address", "Address"],
                  ["directions", "Directions"],
                  ["visitWindow", "Visit hours"],
                ] as const
              ).map(([key, label]) => (
                <FormField key={key} label={label}>
                  <input name={key} defaultValue={detail.outlet[key]} />
                </FormField>
              ))}
              <FormField label="Contact name">
                <input
                  name="contactName"
                  defaultValue={detail.outlet.contacts?.[0]?.name}
                />
              </FormField>
              <FormField label="Contact phone">
                <input
                  name="contactPhone"
                  defaultValue={detail.outlet.contacts?.[0]?.phone}
                />
              </FormField>
              <FormField label="Sales potential">
                <input
                  type="number"
                  min="0"
                  name="salesPotential"
                  defaultValue={detail.outlet.salesPotential}
                />
              </FormField>
              <FormField label="Preferred weekday (0 = Sunday)">
                <input
                  type="number"
                  min="0"
                  max="6"
                  name="preferredWeekday"
                  defaultValue={detail.outlet.preferredWeekday}
                />
              </FormField>
              <FormField label="Visit every (days)">
                <input
                  type="number"
                  min="1"
                  max="365"
                  name="visitFrequencyDays"
                  defaultValue={detail.outlet.visitFrequencyDays}
                />
              </FormField>
            </>
          )}
          {action === "link" && (
            <>
              <FormField label="Customer">
                <select name="customerId">
                  <option value="">Not linked</option>
                  {customers?.page
                    .filter((c) => c.active)
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
              <FormField label="Starts on">
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
              <FormField label="Radius in meters (default 75)">
                <input name="radiusMeters" type="number" min="1" max="500" />
              </FormField>
              <FormField label="Source">
                <input name="source" required />
              </FormField>
              <FormField label="Note">
                <input name="evidenceNote" />
              </FormField>
              <FormField label="Starts on (optional)">
                <input name="effectiveDate" type="date" />
              </FormField>
            </>
          )}
          <FormField label="Reason">
            <input name="reason" required />
          </FormField>
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" className={primaryBtn} disabled={pending}>
              Save
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => setAction(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <section className="grid gap-1 text-[13px]">
        <h4 className="font-semibold text-foreground">Customer history</h4>
        {links?.length ? (
          <ul className="grid gap-1 text-muted">
            {links.map((row) => (
              <li key={row._id}>
                {customerName(row.customerId)} · {row.source} ·{" "}
                {formatManilaDate(row.effectiveFrom)}–
                {row.effectiveTo ? formatManilaDate(row.effectiveTo) : "now"} ·{" "}
                {row.reason}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">None yet.</p>
        )}
      </section>
      <section className="grid gap-1 text-[13px]">
        <h4 className="font-semibold text-foreground">GPS pins</h4>
        <ul className="grid gap-2 text-muted">
          {pins?.map((pin) => (
            <li key={pin._id} className="flex flex-wrap items-center gap-2">
              <span>
                {pin.status[0]?.toUpperCase()}
                {pin.status.slice(1)} · {pin.latitude}, {pin.longitude} ·{" "}
                {pin.radiusMeters} m · {pin.source.replaceAll("_", " ")}
                {pin.evidenceNote ? ` · ${pin.evidenceNote}` : ""} · by{" "}
                {pin.proposerName ?? "Office user"}
                {pin.verifiedBy &&
                  ` · reviewed by ${pin.verifierName ?? "Office user"}: ${pin.reviewerReason ?? ""}`}
                {pin.status === "verified" &&
                  ` · ${formatManilaDate(pin.effectiveFrom)}–${pin.effectiveTo ? formatManilaDate(pin.effectiveTo) : "now"}`}
              </span>
              {pin.status === "pending" && canVerify && (
                <>
                  <button
                    type="button"
                    className={btn}
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
                    className={btn}
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
    </div>
  );
}
