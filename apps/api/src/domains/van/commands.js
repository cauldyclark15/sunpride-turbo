import { tx } from "@sunpride/db/client";
import { routePolicy } from "./route-policy.js";
import { effectiveCash } from "./corrections.js";
import { enqueue } from "../../core/jobs.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { invalid, ApiError } from "../../core/errors.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import {
  currentActor,
  tripFor,
  locationFor,
  outletFor,
  notSelf,
} from "./access.js";
import {
  audit,
  productFor,
  frozenProduct,
  explainStock,
  assertNotCounted,
} from "./facts.js";
import { finishLoad, movement, statusLine } from "./operations.js";
import {
  issueApproval,
  approvalCodeFor,
  approvalKey,
  approvalMessage,
} from "./approvals.js";
import {
  date,
  today,
  uuid,
  integer,
  text,
  choice,
  rows,
  refuse,
  dayString,
} from "./model.js";

/** Web commands reauthorize persisted person and scope before their idempotency lookup.
 * @param {any} ctx @param {any} installCtx @param {string} action @param {string} capability @param {(db:any,actor:any,p:any)=>Promise<any>} fn
 */
export async function command(ctx, installCtx, action, capability, fn) {
  const key = text(
    ctx.req.headers.get("idempotency-key") ?? ctx.body?.idempotencyKey,
    128,
    true,
  );
  const hash = sha256Hex(canonicalJson({ action, payload: ctx.body }));
  const result = await tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor);
    await requireCapability({ db, actor }, capability);
    await db`select set_config('sunpride.actor',${actor.userId},true)`;
    await db`select pg_advisory_xact_lock(hashtextextended(${actor.profileId + ":" + key},0))`;
    const [prior] =
      await db`select * from van_web_commands where actor_profile_id=${actor.profileId} and idempotency_key=${key}`;
    if (prior) {
      if (prior.payload_hash !== hash)
        throw new ApiError(
          "idempotency_conflict",
          409,
          "This request key already belongs to different facts",
        );
      if (prior.result.tripId)
        await tripFor(db, actor, prior.result.tripId, capability);
      if (prior.result.vehicleId) {
        const [v] =
          await db`select org_unit_id from vehicles where id=${prior.result.vehicleId}`;
        await requireCapability({ db, actor }, capability, v?.org_unit_id);
      }
      if (prior.result.outletId)
        await outletFor(db, actor, prior.result.outletId);
      if (prior.result.approvalKind)
        return {
          ...prior.result,
          code: approvalCodeFor(
            approvalKey(
              ctx.env,
              prior.result.tripId,
              prior.result.approvalKind,
            ),
            approvalMessage(
              prior.result.approvalKind,
              prior.result.tripId,
              prior.result,
            ),
          ),
        };
      return prior.result;
    }
    const result = await fn(db, actor, ctx.body);
    const stored = { ...result };
    delete stored.code;
    await db`insert into van_web_commands(actor_profile_id,idempotency_key,payload_hash,result) values(${actor.profileId},${key},${hash},${stored})`;
    if (result.tripId) {
      const [trip] =
        await db`select * from van_trips where id=${result.tripId}`;
      await enqueue(db, {
        kind: "van.refresh",
        key: `van:${trip.org_unit_id}:${dayString(trip.service_date)}`,
        payload: {
          date: dayString(trip.service_date),
          unitId: trip.org_unit_id,
        },
      });
      await installCtx.recordChange(db, {
        entity: "van.bundle",
        entityId: trip.salesperson_profile_id,
        scopeKey: `profile:${trip.salesperson_profile_id}`,
      });
    }
    return result;
  });
  await ctx.publish("van");
  return result;
}
/** @param {any} db @param {any} actor @param {any} p */
export async function createVehicle(db, actor, p) {
  const unitId = uuid(p.orgUnitId);
  await requireCapability({ db, actor }, "van.manage", unitId);
  const truck = await locationFor(db, actor, p.truckLocationId, "van.manage"),
    home = await locationFor(db, actor, p.homeLocationId, "van.manage");
  if (
    truck.type !== "truck" ||
    !truck.allows_sale ||
    home.type === "truck" ||
    truck.id === home.id ||
    truck.org_unit_id !== unitId ||
    home.organization_id !== truck.organization_id
  )
    throw invalid("Choose a sellable truck and a depot in this organization");
  await db`select pg_advisory_xact_lock(hashtextextended(${truck.id},0))`;
  if (
    (
      await db`select 1 from vehicles where truck_location_id=${truck.id} and status='active' and deleted_at is null`
    ).length
  )
    throw invalid("This truck location already has a vehicle");
  const [v] =
    await db`insert into vehicles(organization_id,org_unit_id,vehicle_code,plate_number,name,truck_location_id,home_location_id,capacity_note,status,created_by)
    values(${truck.organization_id},${unitId},${text(p.vehicleCode, 40, true)},${text(p.plateNumber, 20, true)},${text(p.name, 80)},${truck.id},${home.id},${text(p.capacityNote, 200)},'active',${actor.subject}) returning id`;
  await audit(db, null, actor, "van.vehicle.created", v.id);
  return { vehicleId: v.id };
}
/** @param {any} db @param {any} actor @param {any} p */
export async function planTrip(db, actor, p) {
  const [vehicle] =
    await db`select * from vehicles where id=${uuid(p.vehicleId)} and status='active' and deleted_at is null for update`;
  if (!vehicle) throw invalid("Choose an active vehicle");
  await requireCapability({ db, actor }, "van.manage", vehicle.org_unit_id);
  const source = await locationFor(
    db,
    actor,
    p.sourceLocationId ?? vehicle.home_location_id,
    "van.manage",
  );
  const truck = await locationFor(
    db,
    actor,
    vehicle.truck_location_id,
    "van.manage",
  );
  if (
    source.type === "truck" ||
    source.organization_id !== vehicle.organization_id ||
    truck.organization_id !== vehicle.organization_id
  )
    throw invalid("Load from a depot in the same organization");
  if (
    (
      await db`select 1 from inventory_balances where location_id=${truck.id} and physical_base<>0 and deleted_at is null limit 1`
    ).length
  )
    refuse("Truck still holds stock from another trip");
  const serviceDate = date(p.serviceDate);
  if (serviceDate < today())
    throw invalid("A trip cannot be planned for a past day");
  const [seller] =
    await db`select * from profiles where id=${uuid(p.salespersonProfileId)} and status='active' and deleted_at is null for share`;
  if (!seller || !seller.user_id || !roleHas(seller.role, "van.operate"))
    throw invalid("Choose an active van seller");
  await requireCapability({ db, actor }, "van.manage", seller.org_unit_id);
  if (p.routeId) {
    const owners =
      await db`select r.id,o.org_unit_id from routes r join route_territories rt on rt.route_id=r.id join territory_ownerships o on o.territory_id=rt.territory_id
      where r.id=${uuid(p.routeId)} and r.status='active' and r.deleted_at is null and rt.deleted_at is null and o.deleted_at is null and rt.effective_from<=now() and (rt.effective_to is null or rt.effective_to>now()) and o.effective_from<=now() and (o.effective_to is null or o.effective_to>now())`;
    if (!owners.length) throw invalid("Route needs active ownership");
    for (const owner of owners)
      await requireCapability({ db, actor }, "van.manage", owner.org_unit_id);
  }
  const governed =
    (
      await db`select 1 from van_policy_versions where org_unit_id=${vehicle.org_unit_id} limit 1`
    ).length > 0;
  const version = p.operationsVersion ?? (governed ? 1 : 0);
  if (![0, 1].includes(version) || (governed && version !== 1))
    throw invalid(
      "Use the current cold-chain and offline settlement trip configuration",
    );
  const [count] =
    await db`select count(*)::int as n from van_trips where vehicle_id=${vehicle.id} and service_date=${serviceDate}`;
  const tripNumber = `TRIP-${serviceDate.replaceAll("-", "")}-${vehicle.vehicle_code}-${count.n + 1}`;
  const [trip] =
    await db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,route_id,service_date,salesperson_profile_id,salesperson_subject,driver_name,helper_name,status,created_by)
    values(${vehicle.organization_id},${vehicle.org_unit_id},${tripNumber},${vehicle.id},${truck.id},${source.id},${p.routeId ?? null},${serviceDate},${seller.id},${seller.user_id},${text(p.driverName, 80)},${text(p.helperName, 80)},'planned',${actor.subject}) returning id`;
  await audit(db, trip, actor, "van.trip.planned", trip.id);
  if (version === 1) {
    const [planned] = await db`select * from van_trips where id=${trip.id}`;
    for (const kind of [
      "cold_chain",
      "variance",
      "returnables",
      "return_reasons",
    ])
      await routePolicy(
        db,
        planned,
        kind,
        Math.max(
          Date.now(),
          new Date(`${serviceDate}T00:00:00+08:00`).getTime(),
        ),
      );
    await db`update van_trips set operations_version=1 where id=${trip.id}`;
  }
  return { tripId: trip.id, tripNumber };
}
/** @param {any} db @param {any} actor @param {any} p */
export async function planLoad(db, actor, p) {
  const trip = await tripFor(db, actor, p.tripId, "van.manage", true);
  if (trip.status !== "planned") refuse("Issue one load before departure");
  await locationFor(db, actor, trip.source_location_id, "van.manage");
  const [load] =
    await db`insert into van_trip_loads(organization_id,trip_id,load_number,status,created_by) values(${trip.organization_id},${trip.id},1,'planned',${actor.subject}) returning id`;
  const seen = new Set();
  for (const [i, l] of rows(p.lines).entries()) {
    const product = await productFor(db, uuid(l.productId));
    const qty = integer(l.expectedBase, true);
    const lotId = l.lotId ? uuid(l.lotId) : null;
    if (seen.has(`${product.id}:${lotId}`))
      throw invalid("Each product and lot appears once");
    seen.add(`${product.id}:${lotId}`);
    const [lot] = lotId
      ? await db`select * from inventory_lots where id=${lotId} and product_id=${product.id}`
      : [];
    if (lotId && !lot) throw invalid("Lot does not belong to this product");
    await db`insert into van_trip_load_lines(organization_id,load_id,trip_id,line_number,product_id,product_code,uom_code,quantity_scale,lot_id,lot_number,expected_base)
      values(${trip.organization_id},${load.id},${trip.id},${i + 1},${product.id},${product.code},${product.base_code},${String(product.quantityScale)},${lotId},${lot?.lot_number ?? null},${String(qty)})`;
  }
  await db`update van_trips set status='loading' where id=${trip.id}`;
  await audit(db, trip, actor, "van.load.planned", load.id);
  return { tripId: trip.id, loadId: load.id };
}
/** @param {any} db @param {any} actor @param {any} p */
export async function approveLoad(db, actor, p) {
  const trip = await tripFor(db, actor, p.tripId, "van.load.approve", true);
  notSelf(actor, trip);
  const [load] =
    await db`select * from van_trip_loads where trip_id=${trip.id} and status='discrepancy' for update`;
  if (!load || trip.status !== "loading" || load.confirmed_by === actor.subject)
    refuse("No load can be approved by this person");
  await db`update van_trip_loads set approved_by=${actor.subject},approved_at=now(),approval_note=${text(p.note)} where id=${load.id}`;
  const ack = await finishLoad(db, trip, actor);
  await audit(db, trip, actor, "van.load.approved", load.id);
  return { ...ack, tripId: trip.id };
}
/** @param {any} db @param {any} actor @param {any} p */
export async function cancelTrip(db, actor, p) {
  const trip = await tripFor(db, actor, p.tripId, "van.manage", true);
  if (!["planned", "loading"].includes(trip.status))
    refuse("Only an unloaded trip can be cancelled");
  await db`update van_trip_loads set status='cancelled' where trip_id=${trip.id}`;
  await db`update van_trips set status='cancelled',cancelled_at=now(),cancel_reason=${text(p.reason, 200, true)} where id=${trip.id}`;
  await audit(db, trip, actor, "van.trip.cancelled", trip.id, {
    reason: p.reason,
  });
  return { tripId: trip.id };
}
/** @param {any} db @param {any} actor @param {any} p */
export async function decideDamage(db, actor, p) {
  const [record] =
    await db`select * from van_damage_records where id=${uuid(p.damageId)} and deleted_at is null`;
  if (!record) throw invalid("Damage record not found");
  const trip = await tripFor(
    db,
    actor,
    record.trip_id,
    "van.damage.approve",
    true,
  );
  notSelf(actor, trip);
  await assertNotCounted(db, trip.id);
  const [fresh] =
    await db`select * from van_damage_records where id=${record.id} for update`;
  if (fresh.status !== "pending_approval")
    refuse("This damage is already decided");
  const decision = choice(p.decision, ["approve", "reject"]),
    note = text(p.note, 300, decision === "reject");
  let reversal = null;
  if (decision === "reject") {
    const facts = frozenProduct(await productFor(db, record.product_id)),
      qty = BigInt(record.quantity_base);
    reversal = await movement(
      db,
      trip,
      actor,
      "reversal",
      record.id,
      [
        statusLine(
          trip,
          { productId: record.product_id, uomCode: record.uom_code },
          qty,
          "damaged",
          "available",
        ),
      ],
      `damage-reversal:${record.id}`,
    );
    await explainStock(db, trip, record.id, "damage_reversal", [
      { productId: record.product_id, delta: qty, facts },
      { productId: record.product_id, status: "damaged", delta: -qty, facts },
    ]);
  }
  await db`update van_damage_records set status=${decision === "approve" ? "approved" : "rejected"},decided_by=${actor.subject},decided_at=now(),decision_note=${note},reversal_movement_id=${reversal} where id=${record.id}`;
  await audit(db, trip, actor, `van.damage.${decision}`, record.id, { note });
  return { tripId: trip.id, damageId: record.id };
}
/** @param {any} db @param {any} actor @param {any} p */
export async function setCreditTerms(db, actor, p) {
  const outlet = await outletFor(db, actor, p.outletId);
  await requireCapability({ db, actor }, "van.manage");
  const at = new Date(p.effectiveFrom);
  if (
    !Number.isSafeInteger(p.effectiveFrom) ||
    at.getTime() < Date.now() - 1000
  )
    throw invalid("Credit terms must be prospective");
  await db`select id from outlets where id=${outlet.id} for update`;
  if (
    (
      await db`select 1 from outlet_credit_terms where outlet_id=${outlet.id} and effective_from>=${at} and deleted_at is null`
    ).length
  )
    refuse("Terms are already scheduled");
  await db`update outlet_credit_terms set effective_to=${at} where outlet_id=${outlet.id} and (effective_to is null or effective_to>${at}) and deleted_at is null`;
  if (p.terms === null) return { outletId: outlet.id };
  if (
    !Number.isInteger(p.terms?.termsDays) ||
    p.terms.termsDays < 1 ||
    p.terms.termsDays > 180
  )
    throw invalid("Terms must be 1–180 days");
  const [term] =
    await db`insert into outlet_credit_terms(organization_id,outlet_id,terms_days,credit_limit_minor,currency,effective_from,source_ref,actor_subject)
    values(${outlet.organization_id},${outlet.id},${p.terms.termsDays},${String(integer(p.terms.creditLimitMinor, true))},'PHP',${at},${text(p.sourceRef, 200, true)},${actor.subject}) returning id`;
  await audit(db, null, actor, "van.credit.set", term.id, {
    outletId: outlet.id,
    sourceRef: p.sourceRef,
  });
  return { outletId: outlet.id, creditTermsId: term.id };
}
/** A separate office receipt, never inferred from the seller's count. @param {any} db @param {any} actor @param {any} p */
export async function remitCash(db, actor, p) {
  const trip = await tripFor(db, actor, p.tripId, "van.cash.approve", true);
  notSelf(actor, trip);
  if (trip.status === "closed" || trip.status === "cancelled")
    refuse("Trip is already closed");
  const [count] =
    await db`select * from van_cash_counts where trip_id=${trip.id}`;
  if (!count) refuse("The seller must count cash first");
  const amount = integer(p.amountMinor);
  if (amount !== BigInt((await effectiveCash(db, trip.id)).declaredMinor))
    refuse(
      "Received cash must match the declared count; reconcile a changed count before hand-in",
      "stock_conflict",
    );
  if (
    (await db`select 1 from van_cash_remittances where trip_id=${trip.id}`)
      .length
  )
    refuse("Cash has already been received", "idempotency_conflict");
  const [remittance] =
    await db`insert into van_cash_remittances(trip_id,count_id,amount_centavos,received_by,received_by_name,reference)
    values(${trip.id},${count.id},${String(amount)},${actor.profileId},${actor.name},${text(p.reference, 100, true)}) returning id`;
  await audit(db, trip, actor, "van.cash.received", remittance.id, {
    amountMinor: String(amount),
    reference: p.reference,
  });
  return { tripId: trip.id, remittanceId: remittance.id };
}
/** @param {any} db @param {any} actor @param {any} env @param {string} kind @param {any} p */
export async function issueCode(db, actor, env, kind, p) {
  const result = await issueApproval(db, actor, env, kind, p);
  const [trip] =
    await db`select id from van_trips where trip_number=${result.tripNumber}`;
  return { ...result, tripId: trip.id, approvalKind: kind };
}
