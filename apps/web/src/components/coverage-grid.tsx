"use client";

import type { FunctionArgs } from "convex/server";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { coverageMonthDays } from "../lib/coverage-calendar";

type Slot = FunctionArgs<typeof api.coverage.plans.saveSlots>["slots"][number];
type Outlet = {
  outletId: Id<"outlets">;
  routeId?: Id<"routes">;
  territoryId: Id<"territories">;
  sequence?: number;
  expectedDurationMinutes: number;
  requiredObjectives: string[];
  label: string;
};

/** Stable identity for the single visit occurrence per outlet/day. */
export const visitKey = (outletId: Id<"outlets">, date: string) =>
  `visit:${outletId}:${date}`;

export function toggleVisit(
  slots: Slot[],
  outlet: Outlet,
  date: string,
): Slot[] {
  const key = visitKey(outlet.outletId, date);
  if (slots.some((slot) => slot.slotKey === key))
    return slots.filter((slot) => slot.slotKey !== key);
  const max = Math.max(
    0,
    ...slots
      .filter(
        (slot) => slot.serviceDate === date && slot.kind === "outlet_visit",
      )
      .map((slot) => slot.sequence),
  );
  return [
    ...slots,
    {
      slotKey: key,
      serviceDate: date,
      kind: "outlet_visit",
      outletId: outlet.outletId,
      ...(outlet.routeId ? { routeId: outlet.routeId } : {}),
      activityKind: "visit",
      requiredObjectives: outlet.requiredObjectives,
      intents: [],
      sequence: max + 1,
      expectedDurationMinutes: outlet.expectedDurationMinutes,
    },
  ];
}

export function CoverageGrid({
  month,
  outlets,
  slots,
  onChange,
  readOnly,
  isAvailable = () => true,
  frozenForSlot,
}: {
  month: string;
  outlets: Outlet[];
  slots: Slot[];
  onChange: (slots: Slot[]) => void;
  readOnly: boolean;
  isAvailable?: (date: string) => boolean;
  frozenForSlot?: (
    slotKey: string,
  ) => { short: string; long: string } | undefined;
}) {
  const days = coverageMonthDays(month);
  const selected = (outletId: Id<"outlets">, date: string) =>
    slots.find((slot) => slot.slotKey === visitKey(outletId, date));
  function bulk(cells: { outlet: Outlet; date: string }[]) {
    let next = slots;
    for (const { outlet, date } of cells)
      if (isAvailable(date) && !selected(outlet.outletId, date))
        next = toggleVisit(next, outlet, date);
    onChange(next);
  }
  function update(key: string, change: Partial<Slot>) {
    onChange(
      slots.map((slot) =>
        slot.slotKey === key ? { ...slot, ...change } : slot,
      ),
    );
  }
  return (
    <section aria-label="Outlet by day coverage grid" className="grid gap-2">
      <p className="text-xs text-muted">
        Manila local dates · weekdays Sunday=0 · select a cell to add or remove
        a visit. Bulk selection adds missing visits without removing existing
        ones.
      </p>
      <div className="max-h-[38rem] overflow-auto rounded border border-border">
        <table className="w-max min-w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-20 min-w-44 border bg-surface p-1 text-left"
              >
                Outlet / day
              </th>
              {days.map(({ date, day, weekday }) => (
                <th key={date} scope="col" className="min-w-16 border p-1">
                  <button
                    type="button"
                    title={`Add all outlets on ${date}`}
                    aria-label={`Add all on ${date}`}
                    disabled={readOnly || !outlets.length || !isAvailable(date)}
                    onClick={() =>
                      bulk(outlets.map((outlet) => ({ outlet, date })))
                    }
                  >
                    {day}{" "}
                    <small className="block">
                      {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][weekday]}
                    </small>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {outlets.map((outlet) => (
              <tr key={outlet.outletId}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border bg-surface p-1 text-left"
                >
                  <span
                    className="block max-w-40 truncate"
                    title={outlet.label}
                  >
                    {outlet.label}
                  </span>
                  <button
                    type="button"
                    className="text-xs underline"
                    disabled={
                      readOnly || !days.some(({ date }) => isAvailable(date))
                    }
                    onClick={() =>
                      bulk(days.map(({ date }) => ({ outlet, date })))
                    }
                  >
                    Add row
                  </button>
                </th>
                {days.map(({ date }) => {
                  const slot = selected(outlet.outletId, date);
                  const frozen = slot
                    ? frozenForSlot?.(slot.slotKey)
                    : undefined;
                  return (
                    <td
                      key={date}
                      title={frozen?.long}
                      className="border p-0.5 text-center align-top"
                    >
                      <button
                        type="button"
                        aria-label={`${slot ? "Remove" : "Add"} ${outlet.label} on ${date}`}
                        aria-pressed={!!slot}
                        disabled={readOnly || (!slot && !isAvailable(date))}
                        onClick={() =>
                          onChange(toggleVisit(slots, outlet, date))
                        }
                        className={`w-full rounded p-1 ${slot ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                      >
                        {slot ? "✓" : "+"}
                      </button>
                      {slot && (
                        <>
                          {frozen && (
                            <small className="block">{frozen.short}</small>
                          )}
                          <input
                            aria-label={`Sequence ${outlet.label} on ${date}`}
                            title="Daily sequence"
                            type="number"
                            min="1"
                            className="w-12 rounded border bg-surface text-center"
                            value={slot.sequence}
                            disabled={readOnly}
                            onChange={(event) =>
                              update(slot.slotKey, {
                                sequence: Number(event.target.value),
                              })
                            }
                          />
                          <input
                            aria-label={`Objectives ${outlet.label} on ${date}`}
                            title="Visit objectives, comma-separated"
                            className="block w-14 rounded border bg-surface"
                            value={slot.requiredObjectives.join(", ")}
                            disabled={readOnly}
                            onChange={(event) =>
                              update(slot.slotKey, {
                                requiredObjectives: event.target.value
                                  .split(",")
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!outlets.length && (
        <p>Add plan outlets in the cadence editor to start scheduling.</p>
      )}
    </section>
  );
}
