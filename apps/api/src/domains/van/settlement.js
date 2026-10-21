import { canonicalJson, sha256Hex } from "../../core/util.js";
import { forbidden, invalid } from "../../core/errors.js";
import { tripFor, notSelf } from "./access.js";
import { audit, assertTruckStock, expectedStock } from "./facts.js";
import { routePolicy } from "./route-policy.js";
import { requireTemperature } from "./route-evidence.js";
import { uuid, text, refuse, safeNumber } from "./model.js";
import { enqueueApprovedVanSettlement } from "../integration/settlement-adapter.js";

/** F-119: retain the operational request, linked atomically to the canonical SAP outbox.
 * @param {any} db @param {{sourceId:string,kind:string,facts:any}} input
 */
export async function enqueueSapPosting(db, input) {
  if (input.kind !== "van_settlement")
    throw invalid("Unsupported van posting source");
  const [old] =
    await db`select * from van_sap_requests where source_id=${input.sourceId} and kind=${input.kind}`;
  if (old && canonicalJson(old.facts) !== canonicalJson(input.facts))
    refuse("Settlement request facts changed");
  const posting = await enqueueApprovedVanSettlement(db, input.sourceId);
  await db`insert into van_sap_requests(source_id,kind,facts,status) values(${input.sourceId},${input.kind},${input.facts},'pending') on conflict(source_id,kind) do nothing`;
  await db`update van_sap_requests set integration_event_id=${posting.id},status=case when ${posting.quarantined} then 'refused' else status end,updated_at=now() where source_id=${input.sourceId} and kind=${input.kind}`;
  return posting;
}

/** F-117/F-123 frozen, versioned submission, not a warehouse receipt or supervisor approval.
 * @param {any} db @param {any} trip @param {any} actor @param {any} p
 */
export async function submitSettlement(db, trip, actor, p) {
  const id = uuid(p.closeId),
    at = p.deviceTime;
  await requireTemperature(db, trip, at, "interval");
  const [cash] =
    await db`select * from van_cash_counts where trip_id=${trip.id}`;
  const [stock] =
    await db`select * from van_stock_counts where trip_id=${trip.id}`;
  if (!cash || !stock)
    refuse("Count cash and stock before locally completing the trip");
  if (
    (
      await db`select 1 from van_trip_observations a where a.trip_id=${trip.id} and a.kind='stop' and a.facts->>'phase'='arrival' and not exists(select 1 from van_trip_observations d where d.trip_id=a.trip_id and d.kind='stop' and d.facts->>'phase'='departure' and d.facts->>'stopId'=a.facts->>'stopId')`
    ).length
  )
    refuse("Record departure from the open stop before completing the trip");
  if (
    !Number.isFinite(p.endOdometerKm) ||
    p.endOdometerKm < 0 ||
    (trip.start_odometer_km !== null &&
      p.endOdometerKm < trip.start_odometer_km)
  )
    throw invalid("A valid closing odometer reading is required");
  if (
    (BigInt(cash.variance_centavos) !== 0n || stock.variance_lines > 0) &&
    p.exceptionsReviewed !== true
  )
    refuse("Review the cash and stock differences");
  if (!Array.isArray(p.operations) || p.operations.length > 5000)
    throw invalid("Include the trip operation manifest");
  const known =
    await db`select details->>'clientOpId' as id from van_audit_events where trip_id=${trip.id} and details ? 'clientOpId'`;
  const manifest = new Set(
    p.operations.map((/** @type {any} */ o) => uuid(o.clientRequestId)),
  );
  if (
    manifest.size !== p.operations.length ||
    manifest.size !== known.length ||
    known.some((/** @type {any} */ r) => !manifest.has(r.id))
  )
    refuse(
      "Trip manifest must include every accepted operation",
      "dependency_missing",
    );
  for (const op of p.operations) {
    const [r] =
      await db`select op_type from op_receipts where subject=${actor.subject} and device_id=${trip.started_device_id} and client_op_id=${op.clientRequestId} and status='applied'`;
    if (!r || r.op_type !== op.kind)
      refuse(
        "Sync earlier trip operations before submitting to the office",
        "dependency_missing",
      );
  }
  const expected = await expectedStock(db, trip.id);
  await assertTruckStock(db, trip, expected);
  const [unload] =
    await db`select id from van_trip_observations where trip_id=${trip.id} and kind='unload'`;
  if (!unload)
    refuse(
      "Scan the unsold stock, returns and empties before completing the trip",
    );
  if (
    (
      await db`select 1 from van_reload_events e join van_trip_observations o on o.id=e.request_id where o.trip_id=${trip.id} and e.kind='dispatched' and not exists(select 1 from van_reload_events r where r.request_id=e.request_id and r.kind='received')`
    ).length
  )
    refuse("Receive all dispatched reload stock before completing the trip");
  const [prior] =
    await db`select s.*,d.decision from van_settlements s left join van_settlement_decisions d on d.settlement_id=s.id where s.trip_id=${trip.id} order by s.version desc limit 1`;
  if (prior && prior.decision !== "rejected")
    refuse("This trip already has a submitted settlement");
  const policy = await routePolicy(db, trip, "variance", at);
  const [sales] =
    await db`select coalesce(sum(s.total_centavos),0)::text as total from van_sales s where s.trip_id=${trip.id} and not exists(select 1 from van_sale_voids v where v.sale_id=s.id)`;
  const countLines =
    await db`select * from van_stock_count_lines where count_id=${stock.id} order by product_id,stock_status`;
  const events =
    await db`select kind,product_id,stock_status,delta_base::text,facts from van_stock_events where trip_id=${trip.id} order by created_at,id`;
  const payments =
    await db`select kind,method,amount_centavos::text,facts from van_payments where trip_id=${trip.id} order by created_at,id`;
  const documents =
    await db`select id,receipt_number,total_centavos::text,receipt from van_sales where trip_id=${trip.id} order by created_at,id`;
  const abs = (/** @type {bigint} */ n) => (n < 0n ? -n : n);
  const stockValueUnknown = countLines.some(
    (/** @type {any} */ l) =>
      BigInt(l.variance_base) !== 0n && l.value_centavos === null,
  );
  const variance = stockValueUnknown
    ? null
    : abs(BigInt(cash.variance_centavos)) +
      countLines.reduce(
        (/** @type {bigint} */ sum, /** @type {any} */ l) =>
          sum + abs(BigInt(l.value_centavos ?? 0)),
        0n,
      );
  const tolerance = policy.facts.toleranceBasisPoints;
  const breach =
    variance === null ||
    variance * 10000n > BigInt(sales.total) * BigInt(tolerance);
  const facts = {
    state: "pending_supervisor",
    equation: "opening load + reloads − net sales − depot returns = closing",
    physicalExplanation:
      "Customer pickups add physical truck stock; they are not depot returns. Voids reverse sales. Damage changes quality, not total physical stock.",
    cash: {
      expectedCentavos: String(cash.expected_centavos),
      declaredCentavos: String(cash.declared_centavos),
      varianceCentavos: String(cash.variance_centavos),
    },
    salesCentavos: sales.total,
    varianceCentavos: variance === null ? null : String(variance),
    varianceValueSource: "operational count estimate; SAP valuation pending",
    toleranceBasisPoints: tolerance,
    breach,
    events,
    stock: countLines,
    closing: expected.map((e) => ({
      ...e,
      expectedBase: String(e.expectedBase),
    })),
    payments,
    documents,
    unloadId: unload.id,
    manifest: p.operations,
    localFacts: p.localSettlement ?? null,
    startOdometerKm: trip.start_odometer_km,
    endOdometerKm: p.endOdometerKm,
    note: text(p.note),
  };
  const hash = sha256Hex(canonicalJson(facts));
  await db`insert into van_settlements(id,trip_id,version,content_hash,facts,submitted_by,captured_at) values(${id},${trip.id},${(prior?.version ?? 0) + 1},${hash},${facts},${actor.profileId},${new Date(at)})`;
  if (breach)
    await db`insert into van_variance_cases(settlement_id,policy_id,sales_centavos,variance_centavos,tolerance_basis_points,level,due_at) values(${id},${policy.id},${sales.total},${variance === null ? null : String(variance)},${tolerance},'supervisor',now()+${policy.facts.escalateAfterHours}*interval '1 hour')`;
  await db`update van_trips set status='closing',locally_completed_at=${new Date(at)},end_odometer_km=${p.endOdometerKm},updated_at=now() where id=${trip.id}`;
  return { entityId: trip.id, settlementId: id };
}

/** F-118 supervisor then a different area manager, with recorded disposition. @param {any} db @param {any} actor @param {any} p */
export async function decideVariance(db, actor, p) {
  const trip = await tripFor(
    db,
    actor,
    uuid(p.tripId),
    "van.stock.approve",
    true,
  );
  notSelf(actor, trip);
  const [c] =
    await db`select c.* from van_variance_cases c join van_settlements s on s.id=c.settlement_id where c.id=${uuid(p.caseId)} and s.trip_id=${trip.id} for update of c`;
  if (!c || c.level === "disposed")
    throw invalid("Choose an open variance case");
  const note = text(p.note, 300, true),
    action = String(p.action);
  if (!["escalate", "accept", "investigate", "recover"].includes(action))
    throw invalid("Choose an escalation or disposition");
  const previous =
    await db`select actor_profile_id,action from van_variance_decisions where case_id=${c.id} order by created_at,id`;
  // The supervisor must explicitly review first even when the deadline has passed.
  if (c.level === "supervisor" && action !== "escalate")
    refuse("The supervisor must send a tolerance breach to the area manager");
  if (c.level === "area_manager") {
    const [unit] =
      await db`select type_code from org_units where id=${actor.orgUnitId}`;
    if (
      !previous.length ||
      previous.some(
        (/** @type {any} */ r) => r.actor_profile_id === actor.profileId,
      ) ||
      !["region", "area", "national"].includes(unit?.type_code)
    )
      throw forbidden(
        "A different area manager must record the final disposition",
      );
    if (action === "escalate") throw invalid("Choose a final disposition");
  }
  await db`insert into van_variance_decisions(case_id,action,note,actor_profile_id) values(${c.id},${action},${note},${actor.profileId})`;
  await db`update van_variance_cases set level=${action === "escalate" ? "area_manager" : "disposed"},updated_at=now() where id=${c.id}`;
  await audit(db, trip, actor, "van.variance.decision", c.id, { action, note });
  return { tripId: trip.id, caseId: c.id };
}

/** F-117 independent sign-off after sync, receipt and exception disposition. @param {any} db @param {any} actor @param {any} p */
export async function decideSettlement(db, actor, p) {
  const trip = await tripFor(
    db,
    actor,
    uuid(p.tripId),
    "van.stock.approve",
    true,
  );
  notSelf(actor, trip);
  const [s] =
    await db`select * from van_settlements where trip_id=${trip.id} order by version desc limit 1`;
  if (!s || s.id !== uuid(p.settlementId) || s.content_hash !== p.contentHash)
    refuse("The settlement version changed");
  if (
    (
      await db`select 1 from van_settlement_decisions where settlement_id=${s.id}`
    ).length
  )
    refuse("This version already has a decision");
  if (actor.profileId === s.submitted_by)
    throw forbidden("A different supervisor must sign off");
  const decision = p.decision,
    note = text(p.note, 300, true);
  if (!["approved", "rejected"].includes(decision))
    throw invalid("Choose approve or reject");
  if (decision === "approved") {
    if (
      (
        await db`select 1 from inventory_balances where location_id=${trip.truck_location_id} and physical_base<>0 and deleted_at is null`
      ).length
    )
      refuse("Reconcile all remaining physical truck stock before approval");
    if (
      (
        await db`select 1 from van_variance_cases where settlement_id=${s.id} and level<>'disposed'`
      ).length
    )
      refuse("Resolve the variance escalation first");
    const [received] =
      await db`select facts from van_observation_decisions where observation_id=${s.facts.unloadId} and decision='received'`;
    if (!received || received.facts.discrepancy)
      refuse("Warehouse receipt must reconcile before approval");
    const [cash] =
      await db`select r.amount_centavos,c.declared_centavos from van_cash_remittances r join van_cash_counts c on c.trip_id=r.trip_id where r.trip_id=${trip.id}`;
    if (
      !cash ||
      BigInt(cash.amount_centavos) !== BigInt(cash.declared_centavos)
    )
      refuse("Confirm the counted cash at the office before approval");
    if (
      (
        await db`select 1 from van_trip_observations o left join van_observation_decisions d on d.observation_id=o.id where o.trip_id=${trip.id} and o.kind='temperature' and (o.facts->>'excursion'='true' or o.facts->>'lateFromPrior'='true') and (d.id is null or d.decision<>'released')`
      ).length
    )
      refuse("Release the cold-chain excursions before approval");
    await db`update van_trips set status='closed',closed_at=now(),updated_at=now() where id=${trip.id}`;
  }
  await db`insert into van_settlement_decisions(settlement_id,decision,note,actor_profile_id) values(${s.id},${decision},${note},${actor.profileId})`;
  const posting =
    decision === "approved"
      ? await enqueueSapPosting(db, {
          sourceId: s.id,
          kind: "van_settlement",
          facts: {
            ...s.facts,
            contentHash: s.content_hash,
            version: s.version,
          },
        })
      : null;
  await audit(db, trip, actor, `van.settlement.${decision}`, s.id, {
    version: s.version,
    note,
  });
  return {
    tripId: trip.id,
    settlementId: s.id,
    decision,
    postingStatus: posting?.quarantined
      ? "refused_sap"
      : decision === "approved"
        ? "pending_sap"
        : "not_requested",
  };
}

/** F-117/F-118: read exact frozen versions and independent decisions. @param {any} db @param {string} tripId */
export async function settlementVersions(db, tripId) {
  const versions =
    await db`select s.id,s.version,s.content_hash as "contentHash",s.facts,d.decision,p.name as "decidedBy",d.note from van_settlements s left join van_settlement_decisions d on d.settlement_id=s.id left join profiles p on p.id=d.actor_profile_id where s.trip_id=${tripId} order by s.version desc`;
  const cases =
    await db`select c.id,c.settlement_id as "settlementId",c.level,c.tolerance_basis_points as "toleranceBasisPoints",c.variance_centavos::text as "varianceCentavos",c.sales_centavos::text as "salesCentavos",c.due_at as "dueAt" from van_variance_cases c join van_settlements s on s.id=c.settlement_id where s.trip_id=${tripId} order by c.created_at`;
  return { versions, cases };
}
