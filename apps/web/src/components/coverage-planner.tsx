"use client";

import { Button } from "@heroui/react";
import { Card, FormField, StatusPill, WorkspaceIcon } from "@sunpride/ui";
import { api } from "@sunpride/backend/api";
import type { Doc, Id } from "@sunpride/backend/data-model";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useState } from "react";
import { CoverageGrid } from "./coverage-grid";
import {
  currentManilaDate,
  currentManilaMonth,
  manilaInstantDate,
} from "../lib/coverage-calendar";
import { formatManilaDate, manilaDateToUtcMs } from "../lib/manila-date";

const secondaryAction =
  "h-10 rounded-[10px] border border-border bg-surface px-3 text-sm text-foreground";
type Outlet = FunctionArgs<
  typeof api.coverage.plans.saveOutlets
>["outlets"][number];
type Slot = FunctionArgs<typeof api.coverage.plans.saveSlots>["slots"][number];
type Detail = FunctionReturnType<typeof api.coverage.plans.detail>;
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const cadenceNumbers = [
  { key: "weekOrdinal", label: "Ordinal", min: 1, max: 5 },
  { key: "priority", label: "Priority", min: 0 },
  { key: "expectedDurationMinutes", label: "Duration", min: 1 },
  { key: "sequence", label: "Stop order", min: 1 },
] as const;
const cadenceText = [
  { key: "anchorLocalDate", label: "Anchor", type: "date" },
  { key: "customLocalDates", label: "Custom dates", type: "text" },
  { key: "visitWindow", label: "Visit window", type: "text" },
  { key: "requiredObjectives", label: "Outlet objectives", type: "text" },
] as const;
const csv = (text: string) =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

export async function saveCoverageOutlets(
  planId: Id<"coveragePlans">,
  outlets: Outlet[],
  save: (
    args: FunctionArgs<typeof api.coverage.plans.saveOutlets>,
  ) => Promise<unknown>,
) {
  for (const outlet of outlets) {
    for (const date of [
      ...outlet.customLocalDates,
      ...(outlet.anchorLocalDate ? [outlet.anchorLocalDate] : []),
    ]) {
      if (!date.match(/^\d{4}-\d{2}-\d{2}$/))
        throw new Error("Invalid outlet date");
      manilaDateToUtcMs(date);
    }
  }
  return save({ planId, outlets });
}

export async function saveCoverageSlots(
  planId: Id<"coveragePlans">,
  slots: Slot[],
  save: (
    args: FunctionArgs<typeof api.coverage.plans.saveSlots>,
  ) => Promise<unknown>,
) {
  for (const slot of slots) {
    manilaDateToUtcMs(slot.serviceDate);
    if (!Number.isSafeInteger(slot.sequence) || slot.sequence < 1)
      throw new Error("Sequence must be positive");
  }
  return save({ planId, slots });
}

export function saveCoverageAssignment(
  planId: Id<"coveragePlans">,
  fromDate: string,
  toDate: string,
  reason: string,
  save: (
    args: FunctionArgs<typeof api.coverage.plans.setAssignment>,
  ) => Promise<unknown>,
) {
  if (!reason.trim()) throw new Error("Assignment reason required");
  const effectiveFrom = manilaDateToUtcMs(fromDate);
  const effectiveTo = manilaDateToUtcMs(toDate);
  if (effectiveTo <= effectiveFrom)
    throw new Error("End date must follow start date");
  return save({ planId, effectiveFrom, effectiveTo, reason: reason.trim() });
}

export function submitCoveragePlan(
  planId: Id<"coveragePlans">,
  submit: (
    args: FunctionArgs<typeof api.coverage.plans.submit>,
  ) => Promise<unknown>,
) {
  return submit({ planId });
}

export function reviseCoveragePlan(
  planId: Id<"coveragePlans">,
  effectiveFromDate: string,
  reason: string,
  revise: (
    args: FunctionArgs<typeof api.coverage.plans.createRevision>,
  ) => Promise<Doc<"coveragePlans">>,
) {
  if (!reason.trim()) throw new Error("Revision reason required");
  manilaDateToUtcMs(effectiveFromDate);
  return revise({ planId, effectiveFromDate, reason: reason.trim() });
}
const inputOutlet = (row: Doc<"coveragePlanOutlets">): Outlet => ({
  outletId: row.outletId,
  territoryId: row.territoryId,
  ...(row.routeId ? { routeId: row.routeId } : {}),
  frequency: row.frequency,
  ...(row.anchorLocalDate ? { anchorLocalDate: row.anchorLocalDate } : {}),
  ...(row.weekOrdinal ? { weekOrdinal: row.weekOrdinal } : {}),
  preferredWeekdays: row.preferredWeekdays,
  customLocalDates: row.customLocalDates,
  ...(row.sequence ? { sequence: row.sequence } : {}),
  priority: row.priority,
  expectedDurationMinutes: row.expectedDurationMinutes,
  requiredObjectives: row.requiredObjectives,
  ...(row.visitWindow ? { visitWindow: row.visitWindow } : {}),
});
const inputSlot = (row: Doc<"coveragePlanSlots">): Slot => ({
  slotKey: row.slotKey,
  serviceDate: row.serviceDate,
  kind: row.kind,
  ...(row.outletId ? { outletId: row.outletId } : {}),
  ...(row.routeId ? { routeId: row.routeId } : {}),
  ...(row.activityKind ? { activityKind: row.activityKind } : {}),
  ...(row.namedTruckRef ? { namedTruckRef: row.namedTruckRef } : {}),
  requiredObjectives: row.requiredObjectives,
  intents: row.intents,
  sequence: row.sequence,
  expectedDurationMinutes: row.expectedDurationMinutes,
});

/** Standalone, deliberately unmounted until the Sales Force workspace integration. */
export function CoveragePlanner() {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const profile = useQuery(api.domains.profiles.current, {});
  const canRead = permissions?.capabilities.includes("mcp.read") ?? false;
  const canPlan = permissions?.capabilities.includes("mcp.plan") ?? false;
  const [month, setMonth] = useState(currentManilaMonth);
  const [person, setPerson] = useState<Id<"profiles"> | null>(null);
  const [selected, setSelected] = useState<Id<"coveragePlans"> | null>(null);
  const [peopleCursor, setPeopleCursor] = useState<string | null>(null);
  const [revisionReason, setRevisionReason] = useState("");
  const [revisionDate, setRevisionDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const self = profile?._id;
  const people = useQuery(
    api.people.queries.list,
    canRead &&
      permissions?.capabilities.includes("people.read") &&
      permissions.role !== "sales"
      ? { paginationOpts: { numItems: 100, cursor: peopleCursor } }
      : "skip",
  );
  const choices =
    people?.page.filter(
      (p) =>
        p.status === "active" &&
        p.orgUnitId &&
        permissions?.scopeUnitIds.includes(p.orgUnitId),
    ) ?? [];
  // A read-only analyst's own profile may have no employee assignment. Wait for
  // scoped people instead of querying an unassigned self by default.
  const assignee =
    permissions?.role === "sales"
      ? self
      : (person ??
        choices.find((p) => p.role === "sales")?._id ??
        (permissions?.capabilities.includes("people.read") ? undefined : self));
  const plans = useQuery(
    api.coverage.plans.list,
    canRead && assignee
      ? { assigneeProfileId: assignee, localMonth: month }
      : "skip",
  );
  const detail = useQuery(
    api.coverage.plans.detail,
    canRead && selected ? { planId: selected } : "skip",
  );
  const attribution = useQuery(
    api.coverage.discovery.attribution,
    canRead && selected ? { planId: selected } : "skip",
  );
  const create = useMutation(api.coverage.plans.create);
  const revise = useMutation(api.coverage.plans.createRevision);
  async function action(run: () => Promise<Doc<"coveragePlans">>) {
    if (!canPlan || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const plan = await run();
      setSelected(plan._id);
      setNotice(`Version ${plan.version} draft created.`);
      setRevisionReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      label="Plans"
      icon={<WorkspaceIcon name="field" />}
      count={plans?.length}
    >
      <div className="grid gap-4">
        {!canRead ? (
          <p>Coverage access required.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <FormField label="Assignee">
                <select
                  aria-label="Plan assignee"
                  value={assignee ?? ""}
                  disabled={permissions?.role === "sales" || !people}
                  onChange={(e) => {
                    setPerson(e.target.value as Id<"profiles">);
                    setSelected(null);
                  }}
                >
                  {self && (
                    <option value={self}>{profile?.name ?? "My plan"}</option>
                  )}
                  {choices
                    .filter((p) => p._id !== self)
                    .map((p) => (
                      <option key={p._id} value={p._id}>
                        {p.name} · {p.employeeCode ?? p.email}
                      </option>
                    ))}
                </select>
              </FormField>
              {people && !people.isDone && (
                <button
                  className={secondaryAction}
                  type="button"
                  onClick={() => setPeopleCursor(people.continueCursor)}
                >
                  More people
                </button>
              )}
              <FormField label="Month">
                <input
                  aria-label="Plan month"
                  type="month"
                  value={month}
                  onChange={(e) => {
                    setMonth(e.target.value);
                    setSelected(null);
                  }}
                />
              </FormField>
              <Button
                variant="primary"
                className="h-10"
                isDisabled={
                  !canPlan || !assignee || busy || !/^\d{4}-\d{2}$/.test(month)
                }
                onPress={() =>
                  assignee &&
                  void action(() =>
                    create({ assigneeProfileId: assignee, localMonth: month }),
                  )
                }
              >
                New plan
              </Button>
            </div>
            <div className="flex flex-wrap gap-2" aria-label="Plan versions">
              {plans?.map((plan) => (
                <button
                  type="button"
                  key={plan._id}
                  aria-pressed={selected === plan._id}
                  onClick={() => {
                    setSelected(plan._id);
                    setError("");
                  }}
                  className={`flex h-10 items-center gap-2 rounded-[10px] border bg-surface px-3 text-sm ${selected === plan._id ? "border-primary" : "border-border"}`}
                >
                  <span className="tabular-nums">v{plan.version}</span>
                  <StatusPill
                    tone={
                      plan.status === "active" || plan.status === "approved"
                        ? "success"
                        : plan.status === "submitted"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {plan.status}
                  </StatusPill>
                </button>
              ))}
              {plans && !plans.length && <p>No plans this month</p>}
            </div>
            {detail &&
              detail.plan.assigneeProfileId === assignee &&
              detail.plan.localMonth === month && (
                <>
                  <p>
                    v{detail.plan.version} · {detail.plan.status} ·{" "}
                    {formatManilaDate(detail.plan.effectiveFrom)} to{" "}
                    {formatManilaDate(detail.plan.effectiveTo - 1)} · prepared
                    by {attribution?.preparedByName ?? "—"}
                  </p>
                  {detail.plan.status === "draft" &&
                    attribution?.latestReturnReason && (
                      <aside
                        role="status"
                        className="rounded border border-warning p-3"
                      >
                        <strong>Returned for changes</strong>
                        <p>{attribution.latestReturnReason}</p>
                      </aside>
                    )}
                  {(detail.plan.status === "approved" ||
                    detail.plan.status === "active") && (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <FormField label="Revision date">
                        <input
                          type="date"
                          min={currentManilaDate()}
                          max={`${month}-31`}
                          value={revisionDate}
                          onChange={(e) => setRevisionDate(e.target.value)}
                        />
                      </FormField>
                      <FormField label="Revision reason">
                        <input
                          value={revisionReason}
                          onChange={(e) => setRevisionReason(e.target.value)}
                        />
                      </FormField>
                      <button
                        className={secondaryAction}
                        type="button"
                        disabled={
                          !canPlan ||
                          busy ||
                          !revisionReason.trim() ||
                          !revisionDate
                        }
                        onClick={() => {
                          if (!revisionReason.trim()) {
                            setError("Revision reason required");
                            return;
                          }
                          void action(() =>
                            reviseCoveragePlan(
                              detail.plan._id,
                              revisionDate,
                              revisionReason,
                              revise,
                            ),
                          );
                        }}
                      >
                        Revise
                      </button>
                    </div>
                  )}
                  <PlanEditor
                    key={`${detail.plan._id}:${detail.plan.contentRevision}:${detail.plan.status}`}
                    detail={detail}
                    canPlan={canPlan}
                  />
                </>
              )}
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
          </>
        )}
      </div>
    </Card>
  );
}

export function PlanEditor({
  detail,
  canPlan,
}: {
  detail: Detail;
  canPlan: boolean;
}) {
  const { plan } = detail;
  const editable = plan.status === "draft" && canPlan;
  const [outlets, setOutlets] = useState<Outlet[]>(() =>
    detail.outlets.map(inputOutlet),
  );
  const [slots, setSlots] = useState<Slot[]>(() => detail.slots.map(inputSlot));
  const [territoryId, setTerritoryId] = useState<Id<"territories"> | "">("");
  const [routeId, setRouteId] = useState<Id<"routes"> | "">("");
  const [candidate, setCandidate] = useState<Id<"outlets"> | "">("");
  const [outletCursor, setOutletCursor] = useState<string | null>(null);
  const [activityDate, setActivityDate] = useState("");
  const [activityKind, setActivityKind] = useState("");
  const [truck, setTruck] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [assignmentFrom, setAssignmentFrom] = useState(() =>
    manilaInstantDate(plan.effectiveFrom),
  );
  const [assignmentTo, setAssignmentTo] = useState(() =>
    manilaInstantDate(plan.effectiveTo),
  );
  const [assignmentReason, setAssignmentReason] = useState("");
  // Roster as of the plan's first live instant: midnight can precede a same-day assignment.
  const [rosterAsOf] = useState(() => Math.max(plan.effectiveFrom, Date.now()));
  const readPermissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const canOutletRead =
    readPermissions?.capabilities.includes("outlet.read") ?? false;
  const canRouteRead =
    readPermissions?.capabilities.includes("route.read") ?? false;
  const territories = useQuery(
    api.territories.queries.list,
    canOutletRead
      ? { paginationOpts: { numItems: 100, cursor: null } }
      : "skip",
  );
  const roster = useQuery(
    api.outlets.assignments.territoryRoster,
    canOutletRead && territoryId ? { territoryId, asOf: rosterAsOf } : "skip",
  );
  const routes = useQuery(
    api.territories.routes.list,
    canRouteRead && territoryId
      ? { territoryId, paginationOpts: { numItems: 100, cursor: null } }
      : "skip",
  );
  const names = useQuery(
    api.outlets.queries.list,
    canOutletRead
      ? { paginationOpts: { numItems: 100, cursor: outletCursor } }
      : "skip",
  );
  const saveOutlets = useMutation(api.coverage.plans.saveOutlets);
  const setAssignment = useMutation(api.coverage.plans.setAssignment);
  const saveSlots = useMutation(api.coverage.plans.saveSlots);
  const apply = useMutation(api.coverage.routines.applyToDraft);
  const submit = useMutation(api.coverage.plans.submit);
  const routine = useQuery(api.coverage.routines.listForPosition, {
    planId: plan._id,
  });
  const snapshot = (id: Id<"outlets">) =>
    detail.slots.find((s) => s.outletId === id)?.approvedSnapshot;
  const named = (id: Id<"outlets">) =>
    (plan.status !== "draft" ? snapshot(id)?.outletName : undefined) ??
    names?.page.find((o) => o._id === id)?.name ??
    id;
  const rows: Outlet[] =
    plan.status === "draft"
      ? outlets
      : [
          ...outlets,
          ...detail.slots
            .filter(
              (s) =>
                s.kind === "outlet_visit" &&
                s.outletId &&
                !outlets.some((o) => o.outletId === s.outletId),
            )
            .map((s) => ({
              outletId: s.outletId!,
              territoryId:
                s.approvedSnapshot?.territoryId ?? plan.territoryIds[0]!,
              routeId: s.approvedSnapshot?.routeId,
              sequence: s.sequence,
              frequency: "custom" as const,
              preferredWeekdays: [],
              customLocalDates: [],
              priority: 0,
              expectedDurationMinutes: s.expectedDurationMinutes,
              requiredObjectives: s.requiredObjectives,
            }))
            .filter(
              (o, i, all) =>
                all.findIndex((row) => row.outletId === o.outletId) === i,
            ),
        ];
  const visible = rows.filter(
    (o) =>
      (!territoryId ||
        (snapshot(o.outletId)?.territoryId ?? o.territoryId) === territoryId) &&
      (!routeId || (snapshot(o.outletId)?.routeId ?? o.routeId) === routeId),
  );
  const assigned =
    roster?.filter(
      (row) =>
        !outlets.some((o) => o.outletId === row.outletId) &&
        (!routeId || row.routeId === routeId),
    ) ?? [];
  const patchOutlet = (id: Id<"outlets">, change: Partial<Outlet>) =>
    setOutlets((old) =>
      old.map((o) => (o.outletId === id ? { ...o, ...change } : o)),
    );
  async function run(label: string, mutate: () => Promise<unknown>) {
    if (!editable || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await mutate();
      setNotice(label);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const inWindow = (date: string) => {
    const ms = manilaDateToUtcMs(date);
    if (ms < plan.effectiveFrom || ms >= plan.effectiveTo)
      throw new Error(`${date} is outside this plan's effective period`);
  };
  return (
    <section
      aria-label="Selected coverage plan"
      className="grid gap-4 rounded border border-border p-3"
    >
      {!!detail.warnings.length && (
        <aside
          role="status"
          aria-label="Coverage warnings"
          className="rounded border border-warning bg-warning/10 p-3"
        >
          <strong>Advisory warnings</strong>
          <ul className="list-inside list-disc">
            {detail.warnings.map((warning, i) => (
              <li key={`${i}:${warning}`}>{warning}</li>
            ))}
          </ul>
        </aside>
      )}
      {routine?.warning && !detail.warnings.includes(routine.warning) && (
        <p role="status">{routine.warning}</p>
      )}
      {editable && (
        <div
          className="grid gap-3 border-t border-separator pt-4 sm:grid-cols-2 lg:grid-cols-3"
          aria-label="Primary coverage assignment"
        >
          <strong>Assignment period</strong>
          <FormField label="From">
            <input
              aria-label="Assignment from"
              type="date"
              value={assignmentFrom}
              onChange={(e) => setAssignmentFrom(e.target.value)}
            />
          </FormField>
          <FormField label="To">
            <input
              aria-label="Assignment to exclusive"
              type="date"
              value={assignmentTo}
              onChange={(e) => setAssignmentTo(e.target.value)}
            />
          </FormField>
          <FormField label="Reason">
            <input
              aria-label="Assignment reason"
              value={assignmentReason}
              onChange={(e) => setAssignmentReason(e.target.value)}
            />
          </FormField>
          <button
            className={secondaryAction}
            type="button"
            disabled={busy || !assignmentReason.trim()}
            onClick={() =>
              void run("Assignment period saved.", () =>
                saveCoverageAssignment(
                  plan._id,
                  assignmentFrom,
                  assignmentTo,
                  assignmentReason,
                  setAssignment,
                ),
              )
            }
          >
            Save assignment
          </button>
        </div>
      )}
      {editable && (
        <button
          className={secondaryAction}
          type="button"
          disabled={busy}
          onClick={() =>
            void run(
              "Routine applied; review the dated slots below.",
              async () => {
                const result = await apply({ planId: plan._id });
                if (result.warning) setNotice(result.warning);
              },
            )
          }
        >
          Apply weekly routine
        </button>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <FormField label="Territory">
          <select
            aria-label="Coverage territory filter"
            value={territoryId}
            onChange={(e) => {
              setTerritoryId(e.target.value as Id<"territories"> | "");
              setRouteId("");
              setCandidate("");
            }}
          >
            <option value="">All territories</option>
            {territories?.page.map((t) => (
              <option key={t._id} value={t._id}>
                {t.code} · {t.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Route">
          <select
            aria-label="Coverage route filter"
            value={routeId}
            onChange={(e) => setRouteId(e.target.value as Id<"routes"> | "")}
          >
            <option value="">All routes</option>
            {routes?.page.map((r) => (
              <option key={r._id} value={r._id}>
                {r.code} · {r.name}
              </option>
            ))}
          </select>
        </FormField>
        {names && !names.isDone && (
          <button
            className={secondaryAction}
            type="button"
            onClick={() => setOutletCursor(names.continueCursor)}
          >
            More outlet names
          </button>
        )}
      </div>
      {editable && territoryId && (
        <div className="flex gap-2">
          <select
            aria-label="Add plan outlet"
            value={candidate}
            onChange={(e) => setCandidate(e.target.value as Id<"outlets"> | "")}
          >
            <option value="">Select assigned outlet</option>
            {assigned.map((r) => (
              <option key={r._id} value={r.outletId}>
                {named(r.outletId)} · stop {r.sequence ?? "—"}
              </option>
            ))}
          </select>
          <button
            className={secondaryAction}
            type="button"
            disabled={!candidate || busy}
            onClick={() => {
              const row = assigned.find((r) => r.outletId === candidate);
              if (!row) return;
              setOutlets((old) => [
                ...old,
                {
                  outletId: row.outletId,
                  territoryId: row.territoryId,
                  ...(row.routeId ? { routeId: row.routeId } : {}),
                  ...(row.sequence ? { sequence: row.sequence } : {}),
                  frequency: "weekly",
                  preferredWeekdays: [],
                  customLocalDates: [],
                  priority: 1,
                  expectedDurationMinutes: 30,
                  requiredObjectives: [],
                },
              ]);
              setCandidate("");
            }}
          >
            Add outlet to plan
          </button>
        </div>
      )}
      <h3 className="font-semibold">
        Outlet cadence (draft defaults, not automatic slots)
      </h3>
      <p className="text-xs">
        Use preferred weekdays Sunday=0. Custom dates are comma-separated Manila
        dates. Schedule actual occurrences in the grid.
      </p>
      <div className="max-h-80 overflow-auto">
        {visible.map((o) => (
          <div
            key={o.outletId}
            className="grid gap-3 border-b p-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            <strong className="min-w-28">{named(o.outletId)}</strong>
            <FormField label="Frequency">
              <select
                aria-label={`Frequency ${o.outletId}`}
                disabled={!editable}
                value={o.frequency}
                onChange={(e) =>
                  patchOutlet(o.outletId, {
                    frequency: e.target.value as Outlet["frequency"],
                  })
                }
              >
                {["weekly", "biweekly", "monthly", "custom"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </FormField>
            <fieldset disabled={!editable}>
              <legend>Preferred days</legend>
              {weekdays.map((day, index) => (
                <label key={day} className="mr-1">
                  <input
                    type="checkbox"
                    aria-label={`${day} ${o.outletId}`}
                    checked={o.preferredWeekdays.includes(
                      index as 0 | 1 | 2 | 3 | 4 | 5 | 6,
                    )}
                    onChange={(e) =>
                      patchOutlet(o.outletId, {
                        preferredWeekdays: e.target.checked
                          ? [
                              ...o.preferredWeekdays,
                              index as 0 | 1 | 2 | 3 | 4 | 5 | 6,
                            ]
                          : o.preferredWeekdays.filter((d) => d !== index),
                      })
                    }
                  />
                  {day}
                </label>
              ))}
            </fieldset>
            {cadenceNumbers.map(({ key, label, min, ...rest }) => (
              <FormField key={key} label={label}>
                <input
                  aria-label={`${label} ${o.outletId}`}
                  className="w-full"
                  type="number"
                  min={min}
                  max={"max" in rest ? rest.max : undefined}
                  disabled={!editable}
                  value={o[key] ?? ""}
                  onChange={(e) =>
                    patchOutlet(o.outletId, {
                      [key]: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </FormField>
            ))}
            {cadenceText.map(({ key, label, type }) => (
              <FormField key={key} label={label}>
                <input
                  aria-label={`${label} ${o.outletId}`}
                  type={type}
                  disabled={!editable}
                  value={
                    Array.isArray(o[key]) ? o[key].join(", ") : (o[key] ?? "")
                  }
                  onChange={(e) =>
                    patchOutlet(o.outletId, {
                      [key]:
                        key === "customLocalDates" ||
                        key === "requiredObjectives"
                          ? csv(e.target.value)
                          : e.target.value || undefined,
                    })
                  }
                />
              </FormField>
            ))}
            {editable && (
              <button
                className={secondaryAction}
                type="button"
                onClick={() =>
                  setOutlets((old) =>
                    old.filter((row) => row.outletId !== o.outletId),
                  )
                }
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {editable && (
        <button
          className={secondaryAction}
          type="button"
          disabled={busy}
          onClick={() =>
            void run("Outlet cadence saved.", async () => {
              for (const o of outlets)
                for (const date of [
                  ...o.customLocalDates,
                  ...(o.anchorLocalDate ? [o.anchorLocalDate] : []),
                ])
                  inWindow(date);
              await saveCoverageOutlets(plan._id, outlets, saveOutlets);
            })
          }
        >
          Save outlet cadence
        </button>
      )}
      <CoverageGrid
        month={plan.localMonth}
        outlets={visible.map((o) => ({
          ...o,
          label:
            `${snapshot(o.outletId)?.outletCode ?? ""} ${named(o.outletId)}${snapshot(o.outletId)?.routeCode ? ` · ${snapshot(o.outletId)?.routeCode}` : ""}`.trim(),
        }))}
        slots={slots}
        onChange={setSlots}
        readOnly={!editable}
        frozenForSlot={(key) => {
          const frozen = detail.slots.find(
            (s) => s.slotKey === key,
          )?.approvedSnapshot;
          if (!frozen) return undefined;
          return {
            short: `${frozen.routeCode ?? frozen.territoryCode} #${frozen.sequence ?? "—"}`,
            long: `${frozen.outletCode} ${frozen.outletName} · ${frozen.territoryCode} / ${frozen.routeCode ?? "no route"} · stop ${frozen.sequence ?? "—"}`,
          };
        }}
        isAvailable={(date) => {
          const ms = manilaDateToUtcMs(date);
          return (
            date >= currentManilaDate() &&
            ms >= plan.effectiveFrom &&
            ms < plan.effectiveTo
          );
        }}
      />
      <h3 className="font-semibold">
        Non-visit activities (including DS Work-With)
      </h3>
      {editable && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FormField label="Date">
            <input
              aria-label="Activity date"
              type="date"
              min={`${plan.localMonth}-01`}
              max={`${plan.localMonth}-31`}
              value={activityDate}
              onChange={(e) => setActivityDate(e.target.value)}
            />
          </FormField>
          <FormField label="Activity name">
            <input
              aria-label="Activity name"
              value={activityKind}
              onChange={(e) => setActivityKind(e.target.value)}
              placeholder="Work-With / admin / day_off"
            />
          </FormField>
          <FormField label="Named truck (DS Work-With)">
            <input
              aria-label="Named truck"
              value={truck}
              onChange={(e) => setTruck(e.target.value)}
            />
          </FormField>
          <button
            className={secondaryAction}
            type="button"
            disabled={!activityDate || !activityKind.trim()}
            onClick={() => {
              try {
                inWindow(activityDate);
                if (activityDate < currentManilaDate())
                  throw new Error("Cannot schedule an elapsed date");
                if (/work[ -]?with/i.test(activityKind) && !truck.trim())
                  throw new Error("Work-With requires a named truck");
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
                return;
              }
              setError("");
              const key = `activity:${activityDate}:${crypto.randomUUID()}`;
              setSlots((old) => [
                ...old,
                {
                  slotKey: key,
                  serviceDate: activityDate,
                  kind: "non_visit",
                  activityKind: activityKind.trim(),
                  ...(truck.trim() ? { namedTruckRef: truck.trim() } : {}),
                  requiredObjectives: [],
                  intents: [],
                  sequence: 1,
                  expectedDurationMinutes: 0,
                },
              ]);
              setActivityKind("");
              setTruck("");
            }}
          >
            Add activity
          </button>
        </div>
      )}
      <ul className="max-h-48 overflow-auto text-sm">
        {slots
          .filter((s) => s.kind === "non_visit")
          .map((s) => (
            <li key={s.slotKey} className="flex flex-wrap gap-2 border-b p-1">
              <input
                aria-label={`Activity date ${s.slotKey}`}
                type="date"
                disabled={!editable}
                value={s.serviceDate}
                onChange={(e) =>
                  setSlots((old) =>
                    old.map((row) =>
                      row.slotKey === s.slotKey
                        ? { ...row, serviceDate: e.target.value }
                        : row,
                    ),
                  )
                }
              />
              <input
                aria-label={`Activity ${s.slotKey}`}
                disabled={!editable}
                value={s.activityKind ?? ""}
                onChange={(e) =>
                  setSlots((old) =>
                    old.map((row) =>
                      row.slotKey === s.slotKey
                        ? { ...row, activityKind: e.target.value }
                        : row,
                    ),
                  )
                }
              />
              <input
                aria-label={`Truck ${s.slotKey}`}
                title="DS Work-With named truck"
                disabled={!editable}
                value={s.namedTruckRef ?? ""}
                onChange={(e) =>
                  setSlots((old) =>
                    old.map((row) =>
                      row.slotKey === s.slotKey
                        ? { ...row, namedTruckRef: e.target.value || undefined }
                        : row,
                    ),
                  )
                }
              />
              {editable && (
                <button
                  type="button"
                  className="underline"
                  onClick={() =>
                    setSlots((old) =>
                      old.filter((row) => row.slotKey !== s.slotKey),
                    )
                  }
                >
                  Remove
                </button>
              )}
            </li>
          ))}
      </ul>
      {plan.status !== "draft" && (
        <p className="text-sm">
          Read-only {plan.status} version. Approved outlet cells use frozen
          code/name/route snapshots where available; revisions create a separate
          draft.
        </p>
      )}
      {editable && (
        <div className="flex flex-wrap gap-2">
          <button
            className={secondaryAction}
            type="button"
            disabled={busy}
            onClick={() =>
              void run("Dated slots saved.", async () => {
                slots.forEach((s) => inWindow(s.serviceDate));
                await saveCoverageSlots(plan._id, slots, saveSlots);
              })
            }
          >
            Save dated slots
          </button>
          <button
            className={secondaryAction}
            type="button"
            disabled={busy}
            onClick={() =>
              void run("Submitted for independent approval.", () =>
                submitCoveragePlan(plan._id, submit),
              )
            }
          >
            Submit for approval
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
