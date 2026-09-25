"use client";

import { api } from "@sunpride/backend/api";
import type { Doc, Id } from "@sunpride/backend/data-model";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState } from "react";
import { currentManilaMonth } from "../lib/coverage-calendar";
import { manilaDateToUtcMs } from "../lib/manila-date";

type Mode = "review" | "visits" | "history";
type Permissions = {
  role: string;
  capabilities: string[];
  scopeUnitIds: Id<"orgUnits">[];
};
const field = "rounded border border-border bg-surface px-2 py-1 text-sm";
const stamp = (ms?: number) =>
  ms
    ? new Date(ms).toLocaleString("en-PH", {
        timeZone: "Asia/Manila",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
export const coverageStatus = (
  plan: Pick<Doc<"coveragePlans">, "status" | "effectiveFrom">,
) =>
  plan.status === "approved"
    ? plan.effectiveFrom > Date.now()
      ? "Approved · future"
      : "Approved · awaiting activation"
    : plan.status[0]!.toUpperCase() + plan.status.slice(1);

export function returnCoveragePlan(
  planId: Id<"coveragePlans">,
  reason: string,
  run: (
    args: FunctionArgs<typeof api.coverage.plans.returnPlan>,
  ) => Promise<unknown>,
) {
  if (!reason.trim()) throw new Error("Return reason required");
  return run({ planId, reason: reason.trim() });
}
export function approveCoveragePlan(
  planId: Id<"coveragePlans">,
  run: (
    args: FunctionArgs<typeof api.coverage.plans.approve>,
  ) => Promise<unknown>,
) {
  return run({ planId });
}
export function activateCoveragePlan(
  planId: Id<"coveragePlans">,
  run: (
    args: FunctionArgs<typeof api.coverage.activation.activate>,
  ) => Promise<unknown>,
) {
  return run({ planId });
}

/**
 * Approval signatures are `planId:version:approverToken:approvedAt:contentHash`;
 * the approver token itself contains ':' and '|', so read only the stable ends.
 */
export function signatureLabel(signature: string): string {
  const parts = signature.split(":");
  const version = parts[1];
  const hash = parts[parts.length - 1] ?? "";
  if (parts.length < 5 || !/^\d+$/.test(version ?? "")) return "signed";
  return `v${version} · ${hash.slice(0, 12)}`;
}

function auditValue(
  value: unknown,
  actorToken: string,
  actorName: string,
): string {
  if (value === undefined) return "—";
  if (typeof value === "string")
    return value.includes("|")
      ? value === actorToken
        ? actorName
        : "Former user"
      : value;
  if (value !== null && typeof value === "object") {
    const safe = (entry: unknown): unknown => {
      if (typeof entry === "string")
        return auditValue(entry, actorToken, actorName);
      if (Array.isArray(entry)) return entry.map(safe);
      if (entry && typeof entry === "object")
        return Object.fromEntries(
          Object.entries(entry).map(([key, item]) => [
            auditValue(key, actorToken, actorName),
            safe(item),
          ]),
        );
      return entry;
    };
    return JSON.stringify(safe(value));
  }
  return String(value);
}

function PlanHistory({ planId }: { planId: Id<"coveragePlans"> }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<Doc<"coverageAuditEvents">[]>([]);
  const events = useQuery(api.coverage.history.list, {
    planId,
    paginationOpts: { numItems: 20, cursor },
  });
  const attribution = useQuery(api.coverage.discovery.attribution, { planId });
  const rows = [...pages, ...(events?.page ?? [])];
  return (
    <section aria-label="Plan history" className="grid gap-2">
      <h3 className="font-semibold">Plan history</h3>
      {!rows.length && <p>No history yet.</p>}
      <ol className="grid gap-2">
        {rows.map((event) => {
          const actorName =
            attribution?.eventsActorNames[event._id] ?? "Former user";
          const before = event.before ?? {};
          const after = event.after ?? {};
          const keys = [
            ...new Set([...Object.keys(before), ...Object.keys(after)]),
          ];
          return (
            <li
              key={event._id}
              className="rounded border border-border p-2 text-sm"
            >
              <strong>
                {auditValue(event.action, event.actorSubject, actorName)}
              </strong>{" "}
              · {actorName} · {stamp(event.createdAt)}
              <p>Version {event.planVersion}</p>
              {event.reason && (
                <p>
                  Reason:{" "}
                  {auditValue(event.reason, event.actorSubject, actorName)}
                </p>
              )}
              <div>
                <p>Before → After</p>
                {keys.length ? (
                  <ul className="list-inside list-disc">
                    {keys.map((key) => (
                      <li key={key}>
                        {auditValue(key, event.actorSubject, actorName)}:{" "}
                        {auditValue(before[key], event.actorSubject, actorName)}{" "}
                        →{" "}
                        {auditValue(after[key], event.actorSubject, actorName)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No recorded before/after values.</p>
                )}
              </div>
              {event.diff && (
                <p>
                  Changes:{" "}
                  {auditValue(event.diff, event.actorSubject, actorName)}
                </p>
              )}
              {event.affectedRowId && (
                <p>
                  {auditValue(
                    event.affectedEntity,
                    event.actorSubject,
                    actorName,
                  )}
                  :{" "}
                  {auditValue(
                    event.affectedRowId,
                    event.actorSubject,
                    actorName,
                  )}
                </p>
              )}
              {event.approvalSignatureRef && (
                <p>
                  Signed version: {signatureLabel(event.approvalSignatureRef)}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {events && !events.isDone && (
        <button
          type="button"
          className={field}
          onClick={() => {
            setPages(rows);
            setCursor(events.continueCursor);
          }}
        >
          More history
        </button>
      )}
    </section>
  );
}

function PlannedVisits({
  personId,
  month,
}: {
  personId: Id<"profiles">;
  month: string;
}) {
  const visits = useQuery(
    api.coverage.activation.plannedForMonth,
    /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
      ? { assigneeProfileId: personId, localMonth: month }
      : "skip",
  );
  return (
    <section aria-label="Planned visits" className="grid gap-2">
      <h3 className="font-semibold">Planned visits · {month}</h3>
      {visits && !visits.length && (
        <p>No generated visits for this person and month.</p>
      )}
      <ul className="grid gap-2">
        {visits?.map((visit) => (
          <li
            key={visit._id}
            className="rounded border border-border p-2 text-sm"
          >
            <strong>
              {visit.serviceDate} · {visit.approvedSnapshot.outletCode}{" "}
              {visit.approvedSnapshot.outletName}
            </strong>
            <p>
              {visit.approvedSnapshot.routeCode ?? "No route"} · stop{" "}
              {visit.approvedSnapshot.sequence ?? "—"} · v{visit.planVersion} ·{" "}
              {visit.status}
            </p>
            <p>Visit ID: {visit._id}</p>
            {visit.replacedByVisitId && (
              <p>Replaced by: {visit.replacedByVisitId}</p>
            )}
            {visit.replacementOfVisitId && (
              <p>Replaces: {visit.replacementOfVisitId}</p>
            )}
            {visit.cancellationReason && <p>{visit.cancellationReason}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SlotRow({
  slot,
  canOutletRead,
  canRouteRead,
}: {
  slot: Doc<"coveragePlanSlots">;
  canOutletRead: boolean;
  canRouteRead: boolean;
}) {
  const frozen = slot.approvedSnapshot;
  const current = useQuery(
    api.outlets.queries.detail,
    !frozen && slot.outletId && canOutletRead
      ? { outletId: slot.outletId, asOf: manilaDateToUtcMs(slot.serviceDate) }
      : "skip",
  );
  const routeId = slot.routeId ?? current?.assignment?.routeId;
  const route = useQuery(
    api.territories.routes.detail,
    !frozen && routeId && canRouteRead
      ? { routeId, asOf: manilaDateToUtcMs(slot.serviceDate) }
      : "skip",
  );
  return (
    <li className="rounded border border-border p-2 text-sm">
      <strong>
        {slot.serviceDate} ·{" "}
        {slot.kind === "non_visit"
          ? slot.activityKind
          : `${frozen?.outletCode ?? current?.outlet.code ?? slot.outletId ?? "—"} ${frozen?.outletName ?? current?.outlet.name ?? ""}`}
      </strong>
      {slot.namedTruckRef && <span> · truck {slot.namedTruckRef}</span>}
      {slot.kind === "outlet_visit" && (
        <p>
          {frozen ? "Frozen" : "Current at service date"}: customer{" "}
          {frozen?.customerId ??
            current?.customerLink?.customerId ??
            "Prospect / unlinked"}{" "}
          · route {frozen?.routeCode ?? route?.route.code ?? routeId ?? "—"} ·
          stop{" "}
          {frozen?.sequence ?? current?.assignment?.sequence ?? slot.sequence}
        </p>
      )}
      {!!slot.requiredObjectives.length && (
        <p>Objectives: {slot.requiredObjectives.join(", ")}</p>
      )}
    </li>
  );
}

function SelectedPlan({
  planId,
  mode,
  personId,
  month,
  actor,
  reviewerId,
  canApprove,
  canOutletRead,
  canRouteRead,
}: {
  planId: Id<"coveragePlans">;
  mode: Mode;
  personId: Id<"profiles">;
  month: string;
  actor: string;
  reviewerId: Id<"profiles">;
  canApprove: boolean;
  canOutletRead: boolean;
  canRouteRead: boolean;
}) {
  const detail = useQuery(api.coverage.plans.detail, { planId });
  const attribution = useQuery(api.coverage.discovery.attribution, { planId });
  const returned = useMutation(api.coverage.plans.returnPlan);
  const approve = useMutation(api.coverage.plans.approve);
  const activate = useMutation(api.coverage.activation.activate);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [generated, setGenerated] = useState<{
    count: number;
    visitIds: Id<"plannedVisits">[];
  } | null>(null);
  const [openedAt] = useState(Date.now);
  if (!detail || detail.plan._id !== planId) return <p>Loading plan…</p>;
  const { plan, slots, warnings } = detail;
  const independent =
    actor !== plan.preparedBy &&
    actor !== plan.submittedBy &&
    reviewerId !== plan.assigneeProfileId;
  const blocked = !independent
    ? "An independent reviewer must differ from the preparer, submitter and assignee."
    : "";
  const effective = plan.status === "active" || plan.effectiveFrom <= openedAt;
  async function act(fn: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Selected coverage plan"
      className="grid gap-3 rounded border border-border p-3"
    >
      <h3 className="font-semibold">
        {month} · version {plan.version} ·{" "}
        <span className="rounded bg-muted px-2 py-1 text-sm">
          {coverageStatus(plan)}
        </span>
      </h3>
      <p>
        Prepared by {attribution?.preparedByName ?? "—"} ·{" "}
        {stamp(plan.preparedAt)}; submitted by{" "}
        {attribution?.submittedByName ?? "—"} · {stamp(plan.submittedAt)}
      </p>
      {plan.approvedBy && (
        <p>
          Approved by {attribution?.approvedByName ?? "—"} ·{" "}
          {stamp(plan.approvedAt)}
        </p>
      )}
      {plan.basedOnPlanId && (
        <p>
          Revision of {plan.basedOnPlanId}; reason: {plan.revisionReason ?? "—"}
        </p>
      )}
      {warnings.length > 0 && (
        <aside aria-label="Coverage warnings">
          <strong>Advisory warnings</strong>
          <ul>
            {warnings.map((w, i) => (
              <li key={`${i}:${w}`}>{w}</li>
            ))}
          </ul>
        </aside>
      )}
      <h4 className="font-semibold">Dated slots</h4>
      <ul className="grid gap-2">
        {slots.map((slot) => (
          <SlotRow
            key={slot._id}
            slot={slot}
            canOutletRead={canOutletRead}
            canRouteRead={canRouteRead}
          />
        ))}
      </ul>
      {mode === "review" && canApprove && plan.status === "submitted" && (
        <div className="grid gap-2">
          {blocked && <p role="status">{blocked}</p>}
          <label>
            Return reason{" "}
            <input
              aria-label="Return reason"
              className={field}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className={field}
              disabled={busy || !!blocked || !reason.trim()}
              onClick={() =>
                void act(
                  () => returnCoveragePlan(planId, reason, returned),
                  "Returned to draft with reason.",
                )
              }
            >
              Return with reason
            </button>
            <button
              type="button"
              className={field}
              disabled={busy || !!blocked}
              onClick={() =>
                void act(
                  () => approveCoveragePlan(planId, approve),
                  "Plan approved and signed.",
                )
              }
            >
              Approve
            </button>
          </div>
        </div>
      )}
      {mode === "review" &&
        canApprove &&
        (plan.status === "approved" || plan.status === "active") && (
          <div>
            {!effective && (
              <p role="status">
                Approved plan not yet effective; scheduled activation will
                generate visits at its effective start.
              </p>
            )}
            <button
              type="button"
              className={field}
              disabled={busy || !effective}
              onClick={() =>
                void act(async () => {
                  const result = await activateCoveragePlan(planId, activate);
                  setGenerated(
                    result as {
                      count: number;
                      visitIds: Id<"plannedVisits">[];
                    },
                  );
                }, "Planned visits reconciled.")
              }
            >
              Generate / reconcile planned visits
            </button>
            {generated && (
              <p role="status">
                {generated.count} planned visit(s):{" "}
                {generated.visitIds.join(", ") || "none"}
              </p>
            )}
          </div>
        )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {mode === "review" &&
        (plan.status === "approved" ||
          plan.status === "active" ||
          plan.status === "superseded") && (
          <PlannedVisits personId={personId} month={month} />
        )}
      {mode === "history" && <PlanHistory key={planId} planId={planId} />}
    </section>
  );
}

/** Scoped plan discovery is the only picker; people.read is not required. */
export function CoverageReview({
  mode,
  permissions,
  profile,
  scopedSelection,
}: {
  mode: Mode;
  permissions: Permissions;
  profile: Pick<Doc<"profiles">, "_id" | "name" | "authSubject">;
  scopedSelection?: {
    planId: Id<"coveragePlans">;
    assigneeProfileId: Id<"profiles">;
    localMonth: string;
  };
}) {
  const canRead = permissions.capabilities.includes("mcp.read");
  const canApprove = permissions.capabilities.includes("mcp.approve");
  const [month, setMonth] = useState(currentManilaMonth);
  const [selected, setSelected] = useState<Id<"coveragePlans"> | null>(null);
  const [personId, setPersonId] = useState<Id<"profiles"> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [prior, setPrior] = useState<
    NonNullable<
      ReturnType<typeof useQuery<typeof api.coverage.discovery.list>>
    >["page"]
  >([]);
  const discovery = useQuery(
    api.coverage.discovery.list,
    canRead &&
      !scopedSelection &&
      !(mode === "review" && !canApprove) &&
      /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
      ? {
          localMonth: month,
          ...(mode === "review" ? { status: "submitted" as const } : {}),
          paginationOpts: { numItems: 20, cursor },
        }
      : "skip",
  );
  if (!canRead || (mode === "review" && !canApprove))
    return <p>MCP access required.</p>;
  if (scopedSelection)
    return (
      <section aria-label={`Coverage ${mode}`}>
        {mode === "visits" ? (
          <PlannedVisits
            personId={scopedSelection.assigneeProfileId}
            month={scopedSelection.localMonth}
          />
        ) : (
          <SelectedPlan
            key={scopedSelection.planId}
            planId={scopedSelection.planId}
            mode={mode}
            personId={scopedSelection.assigneeProfileId}
            month={scopedSelection.localMonth}
            actor={profile.authSubject}
            reviewerId={profile._id}
            canApprove={canApprove}
            canOutletRead={permissions.capabilities.includes("outlet.read")}
            canRouteRead={permissions.capabilities.includes("route.read")}
          />
        )}
      </section>
    );
  const plans = [...prior, ...(discovery?.page ?? [])].filter(
    (p) => permissions.role !== "sales" || p.assigneeProfileId === profile._id,
  );
  const people = [
    ...new Map(
      plans.map((p) => [p.assigneeProfileId, p.assigneeName]),
    ).entries(),
  ];
  const selectedPerson =
    permissions.role === "sales" ? profile._id : (personId ?? people[0]?.[0]);
  const visible =
    mode === "review"
      ? plans
      : plans.filter((p) => p.assigneeProfileId === selectedPerson);
  return (
    <section aria-label={`Coverage ${mode}`} className="grid gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label>
          Manila month{" "}
          <input
            aria-label="Coverage month"
            className={field}
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              setSelected(null);
              setPersonId(null);
              setPrior([]);
              setCursor(null);
            }}
          />
        </label>
        {mode !== "review" && (
          <label>
            Assignee{" "}
            <select
              aria-label="Coverage assignee"
              className={field}
              value={selectedPerson ?? ""}
              onChange={(e) => {
                setPersonId(e.target.value as Id<"profiles">);
                setSelected(null);
              }}
            >
              {people.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {mode !== "visits" && (
        <>
          <h3 className="font-semibold">
            {mode === "history" ? "Plan versions" : "Submitted plans in scope"}
          </h3>
          <div className="flex flex-wrap gap-2">
            {visible.map((p) => (
              <button
                key={p.planId}
                type="button"
                className={field}
                aria-pressed={selected === p.planId}
                onClick={() => {
                  setSelected(p.planId);
                  setPersonId(p.assigneeProfileId);
                }}
              >
                {p.assigneeName} · {p.localMonth} · v{p.version} · {p.status}
              </button>
            ))}
          </div>
        </>
      )}
      {discovery && !discovery.isDone && (
        <button
          type="button"
          className={field}
          onClick={() => {
            setPrior(plans);
            setCursor(discovery.continueCursor);
          }}
        >
          More plans
        </button>
      )}
      {mode === "visits" && selectedPerson && (
        <PlannedVisits personId={selectedPerson} month={month} />
      )}
      {!selectedPerson && mode !== "review" && (
        <p>No scoped assignee available.</p>
      )}
      {selected && mode !== "visits" && (
        <SelectedPlan
          key={selected}
          planId={selected}
          mode={mode}
          personId={plans.find((p) => p.planId === selected)!.assigneeProfileId}
          month={month}
          actor={profile.authSubject}
          reviewerId={profile._id}
          canApprove={canApprove}
          canOutletRead={permissions.capabilities.includes("outlet.read")}
          canRouteRead={permissions.capabilities.includes("route.read")}
        />
      )}
    </section>
  );
}
