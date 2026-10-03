"use client";

import { Button } from "@heroui/react";
import {
  Card,
  FormField,
  ListRow,
  Pager,
  StatusPill,
  WorkspaceIcon,
} from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { formatManilaDate } from "../lib/manila-date";
import {
  activityFieldsFromForm,
  CONTACT_LABELS,
  encodeFieldsFromForm,
  linesSummary,
  manilaToday,
  OUTSIDE_CALL_ACTIVITY_LABELS,
  parsePoLines,
  RECEIVED_VIA_LABELS,
  STATUS_LABELS,
  type DraftLine,
  type OutsideCallStatus,
} from "../lib/outside-calls";

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
const blankLine = (): DraftLine => ({ productId: "", quantity: "" });

/**
 * CALL-09: a store sends a PO on a day it is not in the salesperson's MCP. The sales admin
 * encodes it here; the credited salesperson records the activity. Supervisors read both.
 * An outside call never counts toward the day's calls.
 */
export function OutsideCallOrders() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const profile = useQuery(api.domains.profiles.current, {});
  const has = (name: string) =>
    permissions?.capabilities.includes(name) ?? false;
  const canEncode = has("order.encode");
  const canRecord = has("visit.record");
  const canRead = has("visit.read");
  const ownOnly = profile?.role === "sales";
  const [status, setStatus] = useState<OutsideCallStatus>("awaiting_activity");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const listArgs = {
    status,
    paginationOpts: { cursor: cursors.at(-1) ?? null, numItems: 20 },
  };
  const listed = useQuery(
    api.orders.outside_calls.list,
    canRead && profile && !ownOnly ? listArgs : "skip",
  );
  const mine = useQuery(
    api.orders.outside_calls.mine,
    canRecord && ownOnly ? listArgs : "skip",
  );
  const cancel = useMutation(api.orders.outside_calls.cancel);
  const record = useMutation(api.orders.outside_calls.recordActivity);
  const [target, setTarget] = useState<{
    id: Id<"outsideCallOrders">;
    action: "cancel" | "record";
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  if (!canRead && !canEncode) return null;
  const result = ownOnly ? mine : listed;
  const rows = result?.page;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = new FormData(event.currentTarget);
      if (target.action === "cancel") {
        const reason = String(data.get("reason") ?? "").trim();
        if (!reason) throw new Error("Reason required");
        await cancel({ orderId: target.id, reason });
        setNotice("PO cancelled.");
      } else {
        await record({ orderId: target.id, ...activityFieldsFromForm(data) });
        setNotice("Activity recorded.");
      }
      setTarget(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      {canEncode && <EncodeOutsideCallPo />}
      <Card
        label={ownOnly ? "My outside-call POs" : "Outside-call POs"}
        count={rows?.length}
        icon={<WorkspaceIcon name="commercial" />}
      >
        <div className="grid gap-4 p-4">
          <p className="text-sm text-muted">
            POs a store sent on a day it was not in the salesperson&apos;s plan.
            They are not counted as calls.
          </p>
          <FormField label="Show">
            <select
              aria-label="Status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as OutsideCallStatus);
                setCursors([null]);
              }}
            >
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
          {rows === undefined ? (
            <p className="text-sm text-muted">Loading POs…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted">No POs here.</p>
          ) : (
            <ul aria-label="Outside-call PO list" className="grid gap-3">
              {rows.map((row) => {
                const { order } = row;
                const own =
                  !!profile && profile._id === order.salespersonProfileId;
                return (
                  <li
                    key={order._id}
                    className="grid gap-2 rounded-xl border border-border p-3"
                  >
                    <ListRow
                      icon={<WorkspaceIcon name="commercial" />}
                      title={`${row.outletName} · PO ${order.poNumber}`}
                      meta={`${row.outletCode} · ${order.serviceDate} · ${RECEIVED_VIA_LABELS[order.receivedVia]} · for ${row.salespersonName} · encoded by ${row.encodedByName} on ${formatManilaDate(order.encodedAt)}`}
                      value={
                        <StatusPill
                          tone={
                            order.status === "activity_recorded"
                              ? "success"
                              : order.status === "cancelled"
                                ? "danger"
                                : "warning"
                          }
                        >
                          {STATUS_LABELS[order.status]}
                        </StatusPill>
                      }
                    />
                    <p className="text-sm">{linesSummary(order.lines)}</p>
                    {order.note && (
                      <p className="text-sm text-muted">Note: {order.note}</p>
                    )}
                    {order.activity && (
                      <p className="text-sm">
                        {CONTACT_LABELS[order.activity.contact]} ·{" "}
                        {order.activity.codes
                          .map(
                            (code) =>
                              OUTSIDE_CALL_ACTIVITY_LABELS[
                                code as keyof typeof OUTSIDE_CALL_ACTIVITY_LABELS
                              ] ?? code,
                          )
                          .join(", ")}
                        {order.activity.note ? ` · ${order.activity.note}` : ""}
                      </p>
                    )}
                    {order.cancelReason && (
                      <p className="text-sm text-muted">
                        Cancelled: {order.cancelReason}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {canRecord &&
                        own &&
                        order.status === "awaiting_activity" && (
                          <Button
                            variant="outline"
                            className="h-8"
                            onPress={() =>
                              setTarget({ id: order._id, action: "record" })
                            }
                          >
                            Record activity
                          </Button>
                        )}
                      {canEncode && order.status !== "cancelled" && (
                        <Button
                          variant="outline"
                          className="h-8"
                          onPress={() =>
                            setTarget({ id: order._id, action: "cancel" })
                          }
                        >
                          Cancel PO
                        </Button>
                      )}
                    </div>
                    {target?.id === order._id && (
                      <form
                        onSubmit={submit}
                        aria-label={
                          target.action === "cancel"
                            ? "Cancel PO"
                            : "Record activity"
                        }
                        className="grid gap-3"
                      >
                        {target.action === "cancel" ? (
                          <FormField label="Reason">
                            <input name="reason" required />
                          </FormField>
                        ) : (
                          <>
                            <FormField label="How you reached the store">
                              <select name="contact" required defaultValue="">
                                <option value="" disabled>
                                  Choose
                                </option>
                                {Object.entries(CONTACT_LABELS).map(
                                  ([value, label]) => (
                                    <option key={value} value={value}>
                                      {label}
                                    </option>
                                  ),
                                )}
                              </select>
                            </FormField>
                            <fieldset className="grid gap-1">
                              <legend className="text-[13px] font-medium">
                                Also done for this store (purchase order is
                                always included)
                              </legend>
                              {Object.entries(OUTSIDE_CALL_ACTIVITY_LABELS)
                                .filter(([code]) => code !== "purchase_order")
                                .map(([code, label]) => (
                                  <label
                                    key={code}
                                    className="flex items-center gap-2 text-sm"
                                  >
                                    <input
                                      type="checkbox"
                                      name="codes"
                                      value={code}
                                    />
                                    {label}
                                  </label>
                                ))}
                            </fieldset>
                            <FormField label="Note">
                              <input name="note" maxLength={500} />
                            </FormField>
                          </>
                        )}
                        <div className="flex gap-2">
                          <Button
                            type="submit"
                            className="h-8"
                            isDisabled={busy}
                          >
                            {target.action === "cancel"
                              ? "Cancel PO"
                              : "Save activity"}
                          </Button>
                          <Button
                            variant="outline"
                            className="h-8"
                            onPress={() => setTarget(null)}
                          >
                            Back
                          </Button>
                        </div>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <Pager
            page={cursors.length}
            canPrevious={cursors.length > 1}
            canNext={!!result && !result.isDone}
            onPrevious={() => setCursors((old) => old.slice(0, -1))}
            onNext={() => {
              if (result && !result.isDone)
                setCursors((old) => [...old, result.continueCursor]);
            }}
            label="Outside-call PO pages"
          />
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
      </Card>
    </div>
  );
}

/** Sales admin form: store, PO date, the salesperson covering the store, and the lines. */
export function EncodeOutsideCallPo() {
  const [outletId, setOutletId] = useState("");
  const [serviceDate, setServiceDate] = useState(() => manilaToday());
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine()]);
  // One id per PO being typed so a retried submit replays instead of duplicating.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const outlets = useQuery(api.outlets.queries.list, {
    paginationOpts: { cursor: null, numItems: 100 },
  });
  const products = useQuery(api.domains.masterData.products, { limit: 100 });
  const candidates = useQuery(
    api.orders.outside_calls.candidates,
    outletId && /^\d{4}-\d{2}-\d{2}$/.test(serviceDate)
      ? { outletId: outletId as Id<"outlets">, serviceDate }
      : "skip",
  );
  const encode = useMutation(api.orders.outside_calls.encode);
  const activeProducts = (products ?? []).filter((product) => product.active);
  const activeOutlets = (outlets?.page ?? []).filter(
    (outlet) => outlet.status === "active",
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const form = event.currentTarget;
    try {
      const fields = encodeFieldsFromForm(new FormData(form));
      const parsed = parsePoLines<Id<"products">>(lines);
      const result = await encode({
        ...fields,
        outletId: fields.outletId as Id<"outlets">,
        salespersonProfileId: fields.salespersonProfileId as Id<"profiles">,
        clientRequestId: requestId,
        lines: parsed,
      });
      setNotice(
        result.replayed
          ? "This PO was already saved."
          : "PO saved. The salesperson can now record the activity.",
      );
      form.reset();
      setOutletId("");
      setLines([blankLine()]);
      setRequestId(crypto.randomUUID());
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((old) =>
      old.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );

  return (
    <Card label="Encode a store PO" icon={<WorkspaceIcon name="commercial" />}>
      <form
        onSubmit={submit}
        aria-label="Encode outside-call PO"
        className="grid gap-4 p-4"
      >
        <p className="text-sm text-muted">
          For a PO a store sent on a day it is not in the salesperson&apos;s
          plan. A PO from a planned store is entered at the visit.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Store">
            <select
              name="outletId"
              required
              value={outletId}
              onChange={(event) => setOutletId(event.target.value)}
            >
              <option value="">Choose a store</option>
              {activeOutlets.map((outlet) => (
                <option key={outlet._id} value={outlet._id}>
                  {outlet.name} ({outlet.code})
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="PO date">
            <input
              type="date"
              name="serviceDate"
              required
              max={manilaToday()}
              value={serviceDate}
              onChange={(event) => setServiceDate(event.target.value)}
            />
          </FormField>
          <FormField
            label="Salesperson"
            hint={
              candidates && !candidates.hasTerritory
                ? "This store has no territory yet. Assign it first."
                : candidates && candidates.salespeople.length === 0
                  ? "Nobody covers this store's territory."
                  : undefined
            }
          >
            <select name="salespersonProfileId" required defaultValue="">
              <option value="">Choose</option>
              {(candidates?.salespeople ?? []).map((person) => (
                <option
                  key={person.profileId}
                  value={person.profileId}
                  disabled={person.inPlan}
                >
                  {person.name}
                  {person.kind === "primary" ? " (primary)" : ""}
                  {person.inPlan ? " — in plan that day" : ""}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Store's PO number">
            <input name="poNumber" required maxLength={60} />
          </FormField>
          <FormField label="PO arrived by">
            <select name="receivedVia" required defaultValue="email">
              {Object.entries(RECEIVED_VIA_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Note">
            <input name="note" maxLength={500} />
          </FormField>
        </div>
        <fieldset className="grid gap-2">
          <legend className="text-[13px] font-medium">Products</legend>
          {lines.map((line, index) => (
            <div
              key={index}
              className="grid gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end"
            >
              <FormField label={`Product ${index + 1}`}>
                <select
                  value={line.productId}
                  onChange={(event) =>
                    setLine(index, { productId: event.target.value })
                  }
                >
                  <option value="">Choose a product</option>
                  {activeProducts.map((product) => (
                    <option key={product._id} value={product._id}>
                      {product.name} ({product.code}, {product.uom})
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label={`Quantity ${index + 1}`}>
                <input
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) =>
                    setLine(index, { quantity: event.target.value })
                  }
                />
              </FormField>
              <Button
                variant="outline"
                className="h-8"
                isDisabled={lines.length === 1}
                onPress={() =>
                  setLines((old) => old.filter((_, i) => i !== index))
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="outline"
              className="h-8"
              onPress={() => setLines((old) => [...old, blankLine()])}
            >
              Add product
            </Button>
          </div>
        </fieldset>
        <div>
          <Button type="submit" className="h-8" isDisabled={busy}>
            Save PO
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </form>
    </Card>
  );
}
