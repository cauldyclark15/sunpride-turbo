import { uuid, choice, refuse } from "./model.js";

/** SEAM(CALLFLOW): van step CONFIGURATION only, consumed by the shared engine at integration.
 * No second execution engine: evidence stays in the existing trip outbox and observation table.
 */
export const vanCallFlowSteps = [
  {
    key: "van.arrive",
    captureKind: "stop.record",
    phase: "arrival",
    required: true,
  },
  {
    key: "van.temperature",
    captureKind: "temperature.record",
    checkpoint: "delivery",
    required: true,
  },
  { key: "van.sale", captureKind: "sale.record", required: false },
  {
    key: "van.return",
    captureKind: "return.record",
    requires: ["photo", "customerAcknowledgement"],
    required: false,
  },
  { key: "van.containers", captureKind: "returnable.record", required: false },
  {
    key: "van.depart",
    captureKind: "stop.record",
    phase: "departure",
    required: true,
  },
];

/** F-105 one open stop at a time; sequence and durations derive from immutable captured times.
 * @param {any} db @param {any} trip @param {any} outlet @param {any} p @param {number} at
 */
export async function stopFacts(db, trip, outlet, p, at) {
  if (!outlet) refuse("Choose a planned store before recording its stop");
  const stopId = uuid(p.stopId),
    phase = choice(p.phase, ["arrival", "departure"]);
  const events =
    await db`select outlet_id,captured_at,facts from van_trip_observations where trip_id=${trip.id} and kind='stop' order by captured_at,id limit 1201`;
  if (events.length >= 1200)
    refuse("The trip exceeds the supported stop bound");
  const arrivals = events.filter(
    (/** @type {any} */ e) => e.facts.phase === "arrival",
  );
  const departures = new Set(
    events
      .filter((/** @type {any} */ e) => e.facts.phase === "departure")
      .map((/** @type {any} */ e) => e.facts.stopId),
  );
  const open = arrivals.find(
    (/** @type {any} */ e) => !departures.has(e.facts.stopId),
  );
  if (phase === "arrival") {
    if (
      open ||
      arrivals.some((/** @type {any} */ e) => e.facts.stopId === stopId)
    )
      refuse("Finish the current stop before arriving at another store");
    const roster = trip.route_id
      ? await db`select outlet_id,sequence from outlet_assignments where route_id=${trip.route_id} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) and deleted_at is null order by sequence,outlet_id limit 601`
      : [];
    if (roster.length > 600)
      refuse("The planned beat exceeds the supported stop bound");
    const planned = roster.find(
      (/** @type {any} */ r) => r.outlet_id === outlet.id,
    );
    return {
      stopId,
      phase,
      actualSequence: arrivals.length + 1,
      plannedSequence: planned?.sequence ?? null,
      outletName: outlet.name,
      arrivedAt: at,
    };
  }
  if (
    !open ||
    open.facts.stopId !== stopId ||
    open.outlet_id !== outlet.id ||
    at < new Date(open.captured_at).getTime()
  )
    refuse("Departure must follow this store’s open arrival");
  return {
    ...open.facts,
    phase,
    departedAt: at,
    durationSeconds: Math.floor(
      (at - new Date(open.captured_at).getTime()) / 1000,
    ),
  };
}
