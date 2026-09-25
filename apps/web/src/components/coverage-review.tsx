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
type Person = {
  _id: Id<"profiles">;
  name: string;
  orgUnitId?: Id<"orgUnits">;
  status: string;
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

const hasEffectiveAssignment = (assignments: Doc<"employeeAssignments">[]) => {
  const now = Date.now();
  return assignments.some(
    (row) =>
      row.effectiveFrom <= now &&
      (row.effectiveTo === undefined || row.effectiveTo > now),
  );
};
function Candidate({
  person,
  month,
  selected,
  onSelect,
  submittedOnly,
  checkAssignment,
}: {
  person: Person;
  month: string;
  selected: Id<"coveragePlans"> | null;
  onSelect: (id: Id<"coveragePlans">, person: Id<"profiles">) => void;
  submittedOnly: boolean;
  checkAssignment: boolean;
}) {
  // An active profile is not necessarily an effective employee assignment.
  // plans.list rejects empty histories without one, so never subscribe blindly.
  const assignments = useQuery(
    api.people.queries.history,
    checkAssignment ? { profileId: person._id } : "skip",
  );
  const hasAssignment =
    !checkAssignment || (assignments && hasEffectiveAssignment(assignments));
  const plans = useQuery(
    api.coverage.plans.list,
    hasAssignment && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
      ? { assigneeProfileId: person._id, localMonth: month }
      : "skip",
  );
  return (
    <>
      {plans
        ?.filter((p) => !submittedOnly || p.status === "submitted")
        .map((p) => (
          <button
            key={p._id}
            type="button"
            className={field}
            aria-pressed={selected === p._id}
            onClick={() => onSelect(p._id, person._id)}
          >
            {person.name} · {month} · v{p.version} · {coverageStatus(p)}
          </button>
        ))}
    </>
  );
}

function PlanHistory({ planId }: { planId: Id<"coveragePlans"> }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<Doc<"coverageAuditEvents">[]>([]);
  const events = useQuery(api.coverage.history.list, {
    planId,
    paginationOpts: { numItems: 20, cursor },
  });
  const rows = [...pages, ...(events?.page ?? [])];
  return (
    <section aria-label="Plan history" className="grid gap-2">
      <h3 className="font-semibold">Plan history</h3>
      {!rows.length && <p>No history yet.</p>}
      <ol className="grid gap-2">
        {rows.map((event) => (
          <li
            key={event._id}
            className="rounded border border-border p-2 text-sm"
          >
            <strong>{event.action}</strong> · {event.actorSubject} ·{" "}
            {stamp(event.createdAt)}
            {event.reason && <p>Reason: {event.reason}</p>}
            <p>Before: {JSON.stringify(event.before ?? {})}</p>
            <p>After: {JSON.stringify(event.after ?? {})}</p>
            {event.diff && <p>Changes: {JSON.stringify(event.diff)}</p>}
            {event.affectedRowId && (
              <p>
                {event.affectedEntity}: {event.affectedRowId}
              </p>
            )}
            {event.approvalSignatureRef && (
              <p>Signed version: {event.approvalSignatureRef}</p>
            )}
          </li>
        ))}
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
  checkAssignment,
  ownSales,
}: {
  personId: Id<"profiles">;
  month: string;
  checkAssignment: boolean;
  ownSales: boolean;
}) {
  const assignments = useQuery(
    api.people.queries.history,
    checkAssignment ? { profileId: personId } : "skip",
  );
  const canList =
    ownSales ||
    (checkAssignment && assignments && hasEffectiveAssignment(assignments));
  const visits = useQuery(
    api.coverage.activation.plannedForMonth,
    canList && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
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
        Prepared by {plan.preparedBy} · {stamp(plan.preparedAt)}; submitted by{" "}
        {plan.submittedBy ?? "—"} · {stamp(plan.submittedAt)}
      </p>
      {plan.approvedBy && (
        <p>
          Approved by {plan.approvedBy} · {stamp(plan.approvedAt)}
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
          <PlannedVisits
            personId={personId}
            month={month}
            checkAssignment
            ownSales={false}
          />
        )}
      {mode === "history" && <PlanHistory key={planId} planId={planId} />}
    </section>
  );
}

/** Backend has person/month list, not a global queue. Query each scoped person on the visible page. */
export function CoverageReview({
  mode,
  permissions,
  profile,
}: {
  mode: Mode;
  permissions: Permissions;
  profile: Pick<Doc<"profiles">, "_id" | "name" | "authSubject">;
}) {
  const canRead = permissions.capabilities.includes("mcp.read");
  const canApprove = permissions.capabilities.includes("mcp.approve");
  const [month, setMonth] = useState(currentManilaMonth);
  const [personId, setPersonId] = useState<Id<"profiles"> | null>(null);
  const [selected, setSelected] = useState<Id<"coveragePlans"> | null>(null);
  const [peopleCursor, setPeopleCursor] = useState<string | null>(null);
  const people = useQuery(
    api.people.queries.list,
    canRead &&
      permissions.capabilities.includes("people.read") &&
      permissions.role !== "sales"
      ? { paginationOpts: { numItems: 100, cursor: peopleCursor } }
      : "skip",
  );
  if (!canRead || (mode === "review" && !canApprove))
    return <p>MCP access required.</p>;
  const self: Person = {
    _id: profile._id,
    name: profile.name,
    status: "active",
  };
  const choices = [
    self,
    ...(people?.page.filter(
      (p) =>
        p._id !== profile._id &&
        p.status === "active" &&
        !!p.orgUnitId &&
        permissions.scopeUnitIds.includes(p.orgUnitId),
    ) ?? []),
  ];
  const selectedPerson =
    personId ??
    (permissions.role === "sales"
      ? profile._id
      : (choices.find((p) => p._id !== profile._id)?._id ?? null));
  const checkAssignment =
    permissions.capabilities.includes("people.read") &&
    permissions.role !== "sales";
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
              {choices.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {people && !people.isDone && (
          <button
            type="button"
            className={field}
            onClick={() => setPeopleCursor(people.continueCursor)}
          >
            More scoped people
          </button>
        )}
      </div>
      {mode === "review" ? (
        <>
          <h3 className="font-semibold">Submitted plans in scope</h3>
          <div className="flex flex-wrap gap-2">
            {choices.map((p) => (
              <Candidate
                key={`${p._id}:${month}`}
                person={p}
                month={month}
                selected={selected}
                submittedOnly
                checkAssignment={checkAssignment}
                onSelect={(id, person) => {
                  setSelected(id);
                  setPersonId(person);
                }}
              />
            ))}
          </div>
        </>
      ) : mode === "history" ? (
        <>
          <h3 className="font-semibold">Plan versions</h3>
          <div className="flex flex-wrap gap-2">
            {selectedPerson && (
              <Candidate
                person={choices.find((p) => p._id === selectedPerson) ?? self}
                month={month}
                selected={selected}
                submittedOnly={false}
                checkAssignment={checkAssignment}
                onSelect={(id) => setSelected(id)}
              />
            )}
          </div>
        </>
      ) : null}
      {mode === "visits" && selectedPerson && (
        <PlannedVisits
          personId={selectedPerson}
          month={month}
          checkAssignment={checkAssignment}
          ownSales={permissions.role === "sales"}
        />
      )}
      {!selectedPerson && mode !== "review" && (
        <p>
          No scoped assignee available. Ask an administrator to provision a
          current employee assignment.
        </p>
      )}
      {selected && selectedPerson && mode !== "visits" && (
        <SelectedPlan
          key={selected}
          planId={selected}
          mode={mode}
          personId={selectedPerson}
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
