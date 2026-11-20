"use client";

import { formatStatus } from "../lib/format";
import { useState } from "react";
import { api } from "./coverage-model";
import { useCoverageMutation, useCoverageQuery } from "./coverage-data";
import type { Detail, Plan } from "./coverage-model";

/** Count pending grid edits as well as retained earlier versions of the month. */
export function planningFrequencyGaps(detail: Detail, slots: Detail["slots"]) {
  const count = (rows: Detail["slots"], id: string) =>
    new Set(
      rows
        .filter((s) => s.kind === "outlet_visit" && s.outletId === id)
        .map((s) => s.serviceDate),
    ).size;
  return (detail.frequencyRequirements ?? [])
    .map((r) => ({
      ...r,
      planned:
        r.planned - count(detail.slots, r.outletId) + count(slots, r.outletId),
    }))
    .filter((r) => r.planned < r.expected);
}

export function DailyPlanRoutes({ detail }: { detail: Detail }) {
  if (!detail.dailyRoutes?.length) return null;
  return (
    <section aria-label="Dated daily routes" className="grid gap-3">
      <h3 className="font-semibold">Daily routes from this approved plan</h3>
      <p>
        The Field app downloads these stops when their plan takes effect.
        Changes need your manager&apos;s approval; earlier versions remain in
        History.
      </p>
      {detail.dailyRoutes.map((r) => (
        <details key={r._id} className="rounded border border-border p-3">
          <summary>
            Route {r.code} · {r.serviceDate}
          </summary>
          <ol className="list-inside list-decimal">
            {detail.slots
              .filter(
                (s) =>
                  s.serviceDate === r.serviceDate && s.kind === "outlet_visit",
              )
              .sort((a, b) => a.sequence - b.sequence)
              .map((s) => (
                <li key={s._id ?? s.slotKey}>
                  {s.approvedSnapshot?.outletName ?? "Customer"} · stop{" "}
                  {s.sequence}
                  {s.approvedSnapshot?.storeWork?.routineName && (
                    <p>{s.approvedSnapshot.storeWork.routineName}</p>
                  )}
                  <ul>
                    {s.approvedSnapshot?.storeWork?.activities.map((a) => (
                      <li key={a.activityId}>
                        {a.name} ·{" "}
                        {detail.storeWorkResults?.find(
                          (r) =>
                            r.slotId === s._id && r.activityId === a.activityId,
                        )?.done
                          ? "Marked done by salesman"
                          : "Not marked done"}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ol>
        </details>
      ))}
    </section>
  );
}

export function WeeklyPlanReview({
  personId,
  isSelf,
  onOpen,
}: {
  personId: string;
  isSelf: boolean;
  onOpen: (plan: Pick<Plan, "_id" | "localMonth">) => void;
}) {
  const week = useCoverageQuery(api.coverage.plans.weekly, {
    assigneeProfileId: personId,
  });
  const confirm = useCoverageMutation(api.coverage.plans.reviewWeek);
  const revise = useCoverageMutation(api.coverage.plans.createRevision);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  if (!week) return null;
  const pending = week.plans.some(
    (p) => p.status === "draft" || p.status === "submitted",
  );
  const approved = week.plans.filter(
    (p) =>
      ["approved", "active", "superseded"].includes(p.status) &&
      p.needed !== false,
  );
  const complete =
    !pending &&
    approved.length > 0 &&
    !week.missingDates?.length &&
    approved.every((p) => p.reviewed);
  async function run(work: () => Promise<unknown>, text: string) {
    setBusy(true);
    setMessage("");
    try {
      await work();
      setMessage(text);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Coming week review"
      className={`grid gap-2 rounded border p-3 ${!complete && (week.reminder || week.overdue) ? "border-warning" : "border-border"}`}
    >
      <h3 className="font-semibold">
        Review the coming week · {week.weekStart} to {week.weekEnd}
      </h3>
      <p role="status">
        {complete
          ? "The coming week's routes have been reviewed."
          : week.overdue
            ? "Weekly review overdue."
            : week.reminder
              ? "Reminder: review your coming routes before Saturday ends."
              : "Review your coming routes by Saturday."}{" "}
        Due {week.dueDate} (Manila time).
      </p>
      {!approved.length && (
        <p>
          No approved plan covers the coming week. Prepare the month and submit
          it to your manager.
        </p>
      )}
      {!!week.missingDates?.length && approved.length > 0 && (
        <p>
          Approved plans are still missing for: {week.missingDates.join(", ")}.
          Prepare those days before confirming the whole week.
        </p>
      )}
      {pending && (
        <p>
          Changes are waiting to be submitted or approved. Your last approved
          routes stay in place until the replacement takes effect.
        </p>
      )}
      {week.plans.map((p) => (
        <div key={p.planId} className="flex flex-wrap items-center gap-2">
          <button
            className="underline"
            onClick={() => onOpen({ _id: p.planId, localMonth: p.month })}
          >
            {p.month} · v{p.version} · {formatStatus(p.status)}
          </button>
          {p.reviewed && <span>Reviewed</span>}
          {isSelf &&
            !p.reviewed &&
            p.needed !== false &&
            ["approved", "active", "superseded"].includes(p.status) && (
              <button
                className="rounded border border-border px-3 py-2"
                disabled={busy || pending}
                onClick={() =>
                  void run(
                    () =>
                      confirm({ planId: p.planId, weekStart: week.weekStart }),
                    "Weekly review saved.",
                  )
                }
              >
                Keep these routes
              </button>
            )}
          {isSelf &&
            p.needed !== false &&
            ["approved", "active"].includes(p.status) && (
              <button
                className="rounded border border-border px-3 py-2"
                disabled={busy || pending}
                onClick={() =>
                  void run(async () => {
                    const plan = await revise({
                      planId: p.planId,
                      effectiveFromDate:
                        p.fromDate > week.weekStart
                          ? p.fromDate
                          : week.weekStart,
                      reason: `Weekly review for ${week.weekStart}`,
                    });
                    onOpen(plan);
                  }, "Adjust the coming days, then submit the revision for approval.")
                }
              >
                Adjust coming week
              </button>
            )}
        </div>
      ))}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
