import { refuse } from "./model.js";
/** F-114 physical van custody: a count is a checkpoint, not a customer issue. @param {any[]} events */
export function vanContainerBalances(events) {
  /** @type {Map<string,any>} */ const balances = new Map();
  for (const e of events) {
    const f = e.facts,
      r = balances.get(f.typeCode) ?? {
        typeCode: f.typeCode,
        label: f.label,
        quantity: null,
      };
    if (f.action === "count" && !e.outlet_id) r.quantity = String(f.quantity);
    if (r.quantity !== null && e.outlet_id && f.action !== "count")
      r.quantity = String(
        BigInt(r.quantity) +
          (f.action === "receive" ? 1n : -1n) * BigInt(f.quantity),
      );
    if (r.quantity !== null && f.action === "warehouse_receive")
      r.quantity = String(BigInt(r.quantity) - BigInt(f.quantity));
    balances.set(f.typeCode, r);
  }
  return [...balances.values()];
}

/** F-114 warehouse empties receipts retire physical van custody; customer debts remain independent.
 * @param {any} db @param {string} vehicleId
 */
export async function containerHistory(db, vehicleId) {
  const events =
    await db`select o.* from van_trip_observations o join van_trips t on t.id=o.trip_id where t.vehicle_id=${vehicleId} and o.kind='returnable' order by o.captured_at,o.id limit 10001`;
  const receipts =
    await db`select d.id,d.created_at,d.facts from van_observation_decisions d join van_trip_observations o on o.id=d.observation_id join van_trips t on t.id=o.trip_id where t.vehicle_id=${vehicleId} and o.kind='unload' and d.decision='received' order by d.created_at,d.id limit 10001`;
  if (events.length > 10000 || receipts.length > 10000)
    refuse(
      "Container custody needs an office archive before download",
      "invalid_request",
    );
  const result = [...events];
  for (const r of receipts)
    for (const e of r.facts.empties ?? [])
      result.push({
        id: r.id + ":" + e.typeCode,
        outlet_id: null,
        captured_at: r.created_at,
        facts: { ...e, action: "warehouse_receive" },
      });
  if (result.length > 10000)
    refuse("Container custody exceeds its supported bound", "invalid_request");
  return result.sort(
    (a, b) =>
      new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime() ||
      String(a.id).localeCompare(String(b.id)),
  );
}
