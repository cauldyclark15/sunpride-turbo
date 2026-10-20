import { routePolicy } from "./route-policy.js";
import { settlementVersions } from "./settlement.js";
import { containerBalances } from "./route-evidence.js";
import { refuse, dayString } from "./model.js";
import { lotBundle } from "./lots.js";
import { vanContainerBalances, containerHistory } from "./container-custody.js";
import { vanCallFlowSteps } from "./callflow-config.js";
import { tripScorecard } from "./scorecard.js";

/** F-117/F-123 only a genuine SAP acknowledgement is posted; a rejection is not pending approval.
 * @param {{decision:string|null}|undefined} latest @param {{status:string}|undefined} posting
 */
export function settlementState(latest, posting) {
  if (!latest) return null;
  if (latest.decision === "rejected") return "rejected";
  if (latest.decision !== "approved") return "pending_supervisor";
  return posting?.status === "acknowledged" ? "posted" : "approved_pending_sap";
}

/** F-105/F-115/F-117 exceptions first; do not tell a loading seller to perform the closing stock count.
 * @param {any} trip @param {any} route @param {{count:any,cash:any,remittance:any}} facts
 */
export function routeNextAction(trip, route, facts) {
  if (route.settlementState === "posted") return "Settlement posted to SAP";
  if (route.settlementState === "approved_pending_sap")
    return "Office sign-off complete; SAP posting acknowledgement is pending";
  if (route.settlementState === "rejected")
    return "Office correction follow-up is required; keep the captured settlement unchanged";
  if (
    route.observations.some(
      (/** @type {any} */ o) =>
        o.kind === "temperature" &&
        (o.facts.excursion || o.facts.lateFromPrior) &&
        o.decision !== "released",
    )
  )
    return "Quality review required: resolve cold-chain exceptions before selling or sign-off";
  if (route.cases.some((/** @type {any} */ c) => c.level !== "disposed"))
    return "Supervisor and area manager must review the variance and record its disposition";
  if (trip.status === "planned")
    return "Review the beat, suggested demand and truck capacity, then plan the load";
  if (trip.status === "loading")
    return "Handheld: scan and confirm the load, and record the load-out temperature";
  if (trip.status === "loaded")
    return "Handheld: record the opening odometer and confirm departure";
  if (!facts.count)
    return "Complete the route, then physically count every stock batch on the handheld";
  if (!facts.cash)
    return "Handheld: count cash before completing the local settlement";
  if (!route.versions.length)
    return "Handheld: save the unload manifest and closing odometer, then complete locally and sync";
  const unload = route.observations.find(
    (/** @type {any} */ o) => o.kind === "unload",
  );
  if (unload?.decisionFacts?.discrepancy)
    return "Reconcile the warehouse receipt discrepancy before sign-off";
  if (unload?.decision !== "received")
    return "Warehouse: receive the scanned stock batches and empty containers";
  if (!facts.remittance) return "Office: confirm receipt of the counted cash";
  return "Supervisor: review and sign off the frozen settlement version";
}

/** F-114/F-115/F-117 one bounded route projection, including immutable captures and office decisions.
 * @param {any} db @param {any} trip
 */
export async function routeBundle(db, trip) {
  if (trip.operations_version !== 1) return null;
  const policies = {};
  for (const kind of [
    "cold_chain",
    "variance",
    "returnables",
    "return_reasons",
  ]) {
    const p = await routePolicy(db, trip, kind, Date.now());
    /** @type {any} */ (policies)[kind] = {
      id: p.id,
      sourceRef: p.source_ref,
      ...p.facts,
    };
  }
  const observations =
    await db`select o.id,o.kind,o.outlet_id as "outletId",s.name as "outletName",o.captured_at as "capturedAt",o.facts,d.decision,d.facts as "decisionFacts" from van_trip_observations o left join van_observation_decisions d on d.observation_id=o.id left join outlets s on s.id=o.outlet_id where o.trip_id=${trip.id} order by o.captured_at,o.id limit 5001`;
  if (observations.length > 5000)
    refuse(
      "Trip evidence exceeds the supported offline bound",
      "invalid_request",
    );
  const custody = await containerHistory(db, trip.vehicle_id);
  const settlements = await settlementVersions(db, trip.id);
  const reloads =
    await db`select o.id,o.facts,coalesce((select jsonb_agg(jsonb_build_object('kind',e.kind,'facts',e.facts) order by e.created_at,e.id) from van_reload_events e where e.request_id=o.id),'[]') as events from van_trip_observations o where o.trip_id=${trip.id} and o.kind='reload_request' order by o.captured_at,o.id`;
  const [posting] =
    await db`select status from van_sap_requests where source_id=${settlements.versions[0]?.id ?? null} and kind='van_settlement'`;
  return {
    version: 1,
    policies,
    observations,
    reloads,
    scorecard: await tripScorecard(db, trip),
    callFlowSteps: vanCallFlowSteps,
    tripFacts: {
      startOdometerKm: trip.start_odometer_km,
      endOdometerKm: trip.end_odometer_km,
    },
    ...(await lotBundle(db, trip)),
    vanContainers: vanContainerBalances(custody),
    containers: containerBalances(custody.filter((e) => e.outlet_id)),
    ...settlements,
    settlementState: settlementState(settlements.versions[0], posting),
  };
}
