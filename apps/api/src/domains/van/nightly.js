import { tx } from "@sunpride/db/client";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { scopeFilterForActor } from "../org/scope.js";
import { actorFor } from "../../core/context.js";
import { partnerVan } from "./partner.js";
import { routePolicy } from "./route-policy.js";
import { addCrew, rostersOn, isoWeekday } from "./roster.js";
import { audit, productFor } from "./facts.js";
import { date, dayString, refuse, today, uuid } from "./model.js";
import { eligibleFreeBase } from "../inventory/eligible.js";

/**
 * IP-VANDAY (SPEC 5.2 step 1): 20:00 Manila creates tomorrow's trips from the roster and a SUGGESTED load for each.
 * Re-running never duplicates: a truck with a trip that day is counted as "already planned" and left alone.
 */

export const SYSTEM = Object.freeze({
  subject: "system:van-nightly",
  userId: null,
  profileId: null,
  name: "Nightly plan",
});

/**
 * The arithmetic of ONE suggested line. Everything is in base pieces. Pure so it can be tested without a database.
 *  need   = the larger of the route's usual sales (average of its last same-weekday trips) and the must-carry minimum
 *  want   = need − what is already on the truck, but never less than the "ship first" quantity the expiry board asked for
 *  result = rounded UP to whole cases, capped at what the depot can free (rounded DOWN to cases when it is short)
 * @param {{averageBase:number, mustCarryBase:number, shipFirstBase:number, onTruckBase:number, caseBase:number, depotFreeBase:number, historyTrips?:number}} i
 */
export function suggestLine(i) {
  const avg = Math.max(0, i.averageBase),
    must = Math.max(0, i.mustCarryBase),
    first = Math.max(0, i.shipFirstBase),
    onTruck = Math.max(0, i.onTruckBase),
    free = Math.max(0, i.depotFreeBase),
    cs = Math.max(0, i.caseBase);
  const need = Math.max(avg, must);
  const want = Math.max(need - onTruck, first, 0);
  /** @type {string[]} */ const flags = [];
  if (must > 0 && must >= avg) flags.push("must_carry");
  if (first > 0) flags.push("ship_first");
  if (!cs) flags.push("no_case_size");
  let qty = cs ? Math.ceil(want / cs) * cs : want;
  if (qty > free) {
    qty = cs ? Math.floor(free / cs) * cs : free;
    if (qty < want) flags.push("depot_short");
  }
  if (want === 0 && onTruck > 0 && need > 0) flags.push("on_truck");
  return { suggestedBase: Math.max(0, qty), flags };
}

/** @param {any} db @param {any} trip */
export async function computeSuggestion(db, trip) {
  const day = dayString(trip.service_date);
  const isoDow = isoWeekday(day);
  const orgUnit = trip.org_unit_id;
  // 1. History: the route's last four same-weekday trips that actually sold something.
  const past = await db`select t.id from van_trips t
    where t.deleted_at is null and t.status<>'cancelled' and t.service_date<${day}::date and extract(isodow from t.service_date)=${isoDow}
      and ((${trip.route_id}::uuid is not null and t.route_id=${trip.route_id}::uuid) or (${trip.route_id}::uuid is null and t.vehicle_id=${trip.vehicle_id}))
      and t.org_unit_id=${orgUnit} and exists(select 1 from van_sales s where s.trip_id=t.id)
    order by t.service_date desc limit 4`;
  const pastIds = past.map((/** @type {any} */ r) => r.id);
  const sold = pastIds.length
    ? await db`select l.product_id,sum(l.quantity_base)::bigint as q from van_sales s join van_sale_lines l on l.sale_id=s.id
        where s.trip_id in ${db(pastIds)} and not exists(select 1 from van_sale_voids v where v.sale_id=s.id) group by l.product_id`
    : [];
  /** @type {Map<string, any>} */ const byProduct = new Map();
  const slot = (/** @type {string} */ id) => {
    if (!byProduct.has(id))
      byProduct.set(id, {
        productId: id,
        averageBase: 0,
        mustCarryBase: 0,
        shipFirstBase: 0,
        onTruckBase: 0,
        depotFreeBase: 0,
      });
    return byProduct.get(id);
  };
  for (const r of sold)
    slot(r.product_id).averageBase = Math.ceil(Number(r.q) / pastIds.length);
  // 2. Must-carry products for this route (or every route of the unit).
  const must = await db`select product_id,max(min_base)::bigint as q from van_must_carry
    where active and (route_id=${trip.route_id}::uuid or (route_id is null)) and (org_unit_id is null or org_unit_id=${orgUnit}) group by product_id`;
  for (const r of must) slot(r.product_id).mustCarryBase = Number(r.q);
  // 3. "Ship first" from the expiry board: batches the office asked to send on the next load, at this depot.
  const first = await db`select a.product_id,
      sum(least(coalesce(a.quantity_base, b.available_base), b.available_base))::bigint as q
    from inventory_expiry_actions a
    join inventory_lot_balances b on b.lot_id=a.lot_id and b.location_id=a.location_id and b.stock_status='available' and b.available_base>0
    where a.action='prioritise' and a.cleared_at is null and a.location_id=${trip.source_location_id} group by a.product_id`;
  for (const r of first) slot(r.product_id).shipFirstBase = Number(r.q);
  // 4. What is already on the truck and what the depot can free up.
  const ids = [...byProduct.keys()];
  const truck = ids.length
    ? await db`select product_id,available_stock_base::bigint as q from inventory_balances where location_id=${trip.truck_location_id} and product_id in ${db(ids)} and deleted_at is null`
    : [];
  for (const r of truck) slot(r.product_id).onTruckBase = Number(r.q);
  // Only stock that approval can actually issue (released, not held, far enough from expiry): same rule as posting.
  const depot = await eligibleFreeBase(db, trip.source_location_id, ids, { org: trip.organization_id });
  for (const [productId, q] of depot) slot(productId).depotFreeBase = q;
  const lines = [];
  for (const s of byProduct.values()) {
    let product;
    try {
      product = await productFor(db, s.productId);
    } catch {
      continue; // an inactive product cannot be loaded
    }
    const caseBase = Number(product.caseBase);
    const r = suggestLine({ ...s, caseBase });
    lines.push({
      ...s,
      caseBase,
      historyTrips: pastIds.length,
      suggestedBase: r.suggestedBase,
      flags: r.flags,
      name: product.name,
      code: product.code,
    });
  }
  lines.sort(
    (a, b) =>
      Number(b.flags.includes("ship_first")) -
        Number(a.flags.includes("ship_first")) ||
      String(a.code).localeCompare(String(b.code)),
  );
  /** @type {string[]} */ const attention = [];
  if (!lines.length || lines.every((l) => l.suggestedBase === 0))
    attention.push(
      pastIds.length
        ? "Nothing to load: the truck already has enough"
        : "No sales history for this route and weekday. Copy yesterday or enter a load",
    );
  if (lines.some((l) => l.flags.includes("depot_short")))
    attention.push("The depot does not have enough for some products");
  return {
    lines,
    attention,
    facts: {
      historyTripIds: pastIds,
      weekday: isoDow,
      algorithm:
        "Average of the route's last 4 same-weekday trips, or the must-carry minimum if larger, less stock already on the truck, never below the batches marked ship-first, rounded up to whole cases and capped at what the depot can free.",
    },
  };
}

/** Write a planned load and its lines. @param {any} db @param {string} tripId @param {{lines:any[], attention:string[], facts:any}} s @param {string} source @param {string} by @param {string|null} [copiedFrom] */
export async function writePlannedLoad(db, tripId, s, source, by, copiedFrom = null) {
  const [plan] =
    await db`insert into van_planned_loads(trip_id,state,source,copied_from_trip_id,attention,facts,created_by) values(${tripId},'suggested',${source},${copiedFrom},${db.array(s.attention, "TEXT")},${s.facts},${by}) returning id`;
  for (const l of s.lines)
    await db`insert into van_planned_load_lines(planned_load_id,product_id,average_base,must_carry_base,ship_first_base,on_truck_base,depot_available_base,case_base,history_trips,suggested_base,flags)
      values(${plan.id},${l.productId},${l.averageBase},${l.mustCarryBase},${l.shipFirstBase},${l.onTruckBase},${l.depotFreeBase},${l.caseBase},${l.historyTrips ?? 0},${l.suggestedBase},${db.array(l.flags, "TEXT")})`;
  return plan.id;
}

/** @param {any} db @param {any} roster @param {string} day @param {string} by @param {'nightly'|'generate'|'copy'} generatedBy */
async function createTripFromRoster(db, roster, day, by, generatedBy) {
  const [seller] =
    await db`select * from profiles where id=${roster.seller_profile_id} and status='active' and deleted_at is null`;
  if (!seller || !seller.user_id || !roleHas(seller.role, "van.operate"))
    return { skip: "The rostered seller is not active" };
  if (roster.vehicle_status !== "active") return { skip: "The truck is not active" };
  const [busy] =
    await db`select t.trip_number,v.vehicle_code from van_trips t join vehicles v on v.id=t.vehicle_id where t.salesperson_profile_id=${seller.id} and t.service_date=${day}::date and t.status not in ('cancelled','closed') and t.deleted_at is null limit 1`;
  if (busy)
    return {
      skip: `${seller.name} already has trip ${busy.trip_number} (${busy.vehicle_code}) that day`,
    };
  const sellerActor = await actorFor(db, seller.user_id);
  if (
    !sellerActor &&
    (await db`select 1 from distributor_users where profile_id=${seller.id} limit 1`)
      .length
  )
    return { skip: "A partner van seller: plan this trip by hand" };
  if (sellerActor && (await partnerVan(db, sellerActor)))
    return { skip: "A partner van seller: plan this trip by hand" };
  const sourceId = roster.source_location_id ?? roster.home_location_id;
  const governed =
    (
      await db`select 1 from van_policy_versions where org_unit_id=${roster.org_unit_id} limit 1`
    ).length > 0;
  const version = governed ? 1 : 0;
  const [count] =
    await db`select count(*)::int as n from van_trips where vehicle_id=${roster.vehicle_id} and service_date=${day}::date`;
  const tripNumber = `TRIP-${day.replaceAll("-", "")}-${roster.vehicle_code}-${count.n + 1}`;
  const [helper] = roster.helper_profile_id
    ? await db`select name from profiles where id=${roster.helper_profile_id}`
    : [];
  const [driver] = roster.driver_profile_id
    ? await db`select name from profiles where id=${roster.driver_profile_id}`
    : [];
  const [trip] =
    await db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,route_id,service_date,salesperson_profile_id,salesperson_subject,driver_name,helper_name,status,created_by,roster_id,generated_by)
    values(${roster.organization_id},${roster.org_unit_id},${tripNumber},${roster.vehicle_id},${roster.truck_location_id},${sourceId},${roster.route_id},${day}::date,${seller.id},${seller.user_id},${driver?.name ?? null},${helper?.name ?? null},'planned',${by},${roster.id},${generatedBy}) returning *`;
  if (version === 1) {
    for (const kind of [
      "cold_chain",
      "variance",
      "returnables",
      "return_reasons",
    ])
      await routePolicy(
        db,
        trip,
        kind,
        Math.max(Date.now(), new Date(`${day}T00:00:00+08:00`).getTime()),
      );
    await db`update van_trips set operations_version=1 where id=${trip.id}`;
  }
  await addCrew(
    db,
    trip.id,
    [
      { profileId: seller.id, role: "seller" },
      { profileId: roster.helper_profile_id, role: "helper" },
      { profileId: roster.driver_profile_id, role: "driver" },
    ],
    "roster",
    by,
  );
  return { trip };
}

/**
 * Make the trips (and suggested loads) of one Manila day. Safe to run again: it only adds what is missing.
 * @param {any} db @param {{day:string, unitId?:string|null, by:string, trigger:'nightly'|'generate'|'copy', scopeUnitIds?:string[]|null, actor?:any}} o
 */
export async function generateTrips(db, o) {
  const day = date(o.day);
  const rosters = await rostersOn(db, day, o.unitId ?? null);
  /** @type {any[]} */ const detail = [];
  let planned = 0,
    existed = 0,
    attention = 0;
  for (const roster of rosters) {
    if (o.scopeUnitIds && !o.scopeUnitIds.includes(roster.org_unit_id)) continue;
    const row = {
      rosterId: roster.id,
      vehicleCode: roster.vehicle_code,
      tripId: /** @type {string|null} */ (null),
      result: "planned",
      note: /** @type {string|null} */ (null),
    };
    const [there] =
      await db`select id,roster_id from van_trips where vehicle_id=${roster.vehicle_id} and service_date=${day}::date and status not in ('cancelled','closed') and deleted_at is null limit 1`;
    if (there) {
      existed++;
      detail.push({ ...row, tripId: there.id, result: "already_planned" });
      continue;
    }
    // A savepoint, so one bad roster line never stops the other eleven trucks.
    try {
      await db.savepoint(async (/** @type {any} */ sp) => {
        const made = await createTripFromRoster(sp, roster, day, o.by, o.trigger);
        if (made.skip) {
          attention++;
          detail.push({ ...row, result: "needs_attention", note: made.skip });
          return;
        }
        const trip = made.trip;
        const suggestion = await computeSuggestion(sp, trip);
        await writePlannedLoad(sp, trip.id, suggestion, "nightly", o.by);
        if (suggestion.attention.length) attention++;
        planned++;
        detail.push({
          ...row,
          tripId: trip.id,
          result: suggestion.attention.length ? "planned_needs_attention" : "planned",
          note: suggestion.attention[0] ?? null,
        });
      });
    } catch (e) {
      attention++;
      detail.push({
        ...row,
        result: "needs_attention",
        note: e instanceof ApiError ? e.message : "Could not plan this truck",
      });
    }
  }
  await db`insert into van_nightly_runs(org_unit_id,service_date,trigger,planned,already_planned,needs_attention,detail,ran_by) values(${o.unitId ?? null},${day}::date,${o.trigger},${planned},${existed},${attention},${{ trips: detail }},${o.by})`;
  return { date: day, planned, alreadyPlanned: existed, needsAttention: attention, trips: detail };
}

/** POST van/trips/generate {date, unitId?}. @param {any} db @param {any} actor @param {any} p */
export async function generateCommand(db, actor, p) {
  await requireCapability({ db, actor }, "van.manage");
  const day = date(p.date);
  if (day < today()) refuse("A trip cannot be planned for a past day");
  const scope = await scopeFilterForActor(db, actor);
  if (p.unitId) await requireCapability({ db, actor }, "van.manage", uuid(p.unitId));
  const r = await generateTrips(db, {
    day,
    unitId: p.unitId ?? null,
    by: actor.subject,
    trigger: "generate",
    scopeUnitIds: scope.unitIds,
  });
  await audit(db, null, actor, "van.trips.generated", crypto.randomUUID(), {
    date: day,
    planned: r.planned,
  });
  // `tripIds` makes the command wrapper refresh each seller's bundle.
  return { ...r, tripIds: r.trips.filter((/** @type {any} */ t) => t.tripId && t.result.startsWith("planned")).map((/** @type {any} */ t) => t.tripId) };
}

/**
 * "Copy yesterday": for every truck that ran on `fromDate` and has no trip on `toDate`, plan the same seller, crew,
 * route and the load it actually went out with. Already-planned trucks are left alone.
 * @param {any} db @param {any} actor @param {any} p `{fromDate, toDate, unitId?}`
 */
export async function copyTrips(db, actor, p) {
  await requireCapability({ db, actor }, "van.manage");
  const from = date(p.fromDate),
    to = date(p.toDate);
  if (to < today()) refuse("A trip cannot be planned for a past day");
  if (from >= to) refuse("Copy from an earlier day");
  const scope = await scopeFilterForActor(db, actor);
  const all = scope.unitIds === null,
    ids = scope.unitIds?.length
      ? scope.unitIds
      : ["00000000-0000-0000-0000-000000000000"];
  const source = await db`select t.*,v.vehicle_code,v.status as vehicle_status,v.home_location_id from van_trips t join vehicles v on v.id=t.vehicle_id
    where t.service_date=${from}::date and t.status<>'cancelled' and t.deleted_at is null and (${all} or t.org_unit_id in ${db(ids)})
      and (${p.unitId ?? null}::uuid is null or t.org_unit_id=${p.unitId ?? null}::uuid) order by v.vehicle_code limit 500`;
  /** @type {any[]} */ const detail = [];
  let planned = 0,
    existed = 0,
    attention = 0;
  for (const old of source) {
    await requireCapability({ db, actor }, "van.manage", old.org_unit_id);
    const [there] =
      await db`select id from van_trips where vehicle_id=${old.vehicle_id} and service_date=${to}::date and status not in ('cancelled','closed') and deleted_at is null limit 1`;
    if (there) {
      existed++;
      detail.push({ vehicleCode: old.vehicle_code, tripId: there.id, result: "already_planned" });
      continue;
    }
    try {
      await db.savepoint(async (/** @type {any} */ sp) => {
        const [seller] =
          await sp`select id,name,user_id,role from profiles where id=${old.salesperson_profile_id} and status='active' and deleted_at is null`;
        const crewRows = await sp`select profile_id,role from van_trip_crew where trip_id=${old.id} and ended_at is null`;
        const fake = {
          id: old.roster_id ?? null,
          organization_id: old.organization_id,
          org_unit_id: old.org_unit_id,
          vehicle_id: old.vehicle_id,
          vehicle_code: old.vehicle_code,
          vehicle_status: old.vehicle_status,
          route_id: old.route_id,
          seller_profile_id: seller?.id ?? old.salesperson_profile_id,
          helper_profile_id: crewRows.find((/** @type {any} */ c) => c.role === "helper")?.profile_id ?? null,
          driver_profile_id: crewRows.find((/** @type {any} */ c) => c.role === "driver")?.profile_id ?? null,
          source_location_id: old.source_location_id,
          home_location_id: old.home_location_id,
          truck_location_id: old.truck_location_id,
        };
        const made = await createTripFromRoster(sp, fake, to, actor.subject, "copy");
        if (made.skip) {
          attention++;
          detail.push({ vehicleCode: old.vehicle_code, result: "needs_attention", note: made.skip });
          return;
        }
        const lines = await loadedLines(sp, old.id);
        await writePlannedLoad(
          sp,
          made.trip.id,
          await suggestionFromLines(sp, made.trip, lines),
          "copy",
          actor.subject,
          old.id,
        );
        planned++;
        detail.push({ vehicleCode: old.vehicle_code, tripId: made.trip.id, result: "planned" });
      });
    } catch (e) {
      attention++;
      detail.push({
        vehicleCode: old.vehicle_code,
        result: "needs_attention",
        note: e instanceof ApiError ? e.message : "Could not copy this truck",
      });
    }
  }
  await db`insert into van_nightly_runs(org_unit_id,service_date,trigger,planned,already_planned,needs_attention,detail,ran_by) values(${p.unitId ?? null},${to}::date,'copy',${planned},${existed},${attention},${{ trips: detail }},${actor.subject})`;
  return {
    date: to,
    planned,
    alreadyPlanned: existed,
    needsAttention: attention,
    trips: detail,
    tripIds: detail.filter((/** @type {any} */ t) => t.tripId && t.result === "planned").map((/** @type {any} */ t) => t.tripId),
  };
}

/** What a trip actually went out with, by product (the accepted count, else what was sent, else what was planned). @param {any} db @param {string} tripId */
export async function loadedLines(db, tripId) {
  const lines = await db`select product_id as "productId",sum(coalesce(actual_base,expected_base))::bigint as q from van_trip_load_lines where trip_id=${tripId} and deleted_at is null group by product_id`;
  if (lines.length)
    return lines.map((/** @type {any} */ l) => ({ productId: l.productId, quantityBase: Number(l.q) }));
  const planned = await db`select l.product_id as "productId",coalesce(l.approved_base,l.suggested_base)::bigint as q from van_planned_loads p join van_planned_load_lines l on l.planned_load_id=p.id where p.trip_id=${tripId} and p.state<>'cancelled' and coalesce(l.approved_base,l.suggested_base)>0`;
  return planned.map((/** @type {any} */ l) => ({ productId: l.productId, quantityBase: Number(l.q) }));
}

/** A suggestion whose quantities are given (copy yesterday), with the same facts about the truck and depot. @param {any} db @param {any} trip @param {Array<{productId:string, quantityBase:number}>} want */
export async function suggestionFromLines(db, trip, want) {
  const base = await computeSuggestion(db, trip);
  /** @type {Map<string, any>} */ const bySku = new Map(base.lines.map((/** @type {any} */ l) => [l.productId, l]));
  const lines = [];
  for (const w of want) {
    const l = bySku.get(w.productId);
    const product = await productFor(db, w.productId).catch(() => null);
    if (!product) continue;
    const [truck] =
      await db`select available_stock_base::bigint as q from inventory_balances where location_id=${trip.truck_location_id} and product_id=${w.productId} and deleted_at is null`;
    const free = (await eligibleFreeBase(db, trip.source_location_id, [w.productId], { org: trip.organization_id })).get(w.productId) ?? 0;
    const flags = ["copied"];
    let qty = w.quantityBase;
    if (qty > free) {
      qty = Number(product.caseBase) ? Math.floor(free / Number(product.caseBase)) * Number(product.caseBase) : free;
      flags.push("depot_short");
    }
    lines.push({
      productId: w.productId,
      averageBase: l?.averageBase ?? 0,
      mustCarryBase: l?.mustCarryBase ?? 0,
      shipFirstBase: l?.shipFirstBase ?? 0,
      onTruckBase: Number(truck?.q ?? 0),
      depotFreeBase: free,
      caseBase: Number(product.caseBase),
      historyTrips: l?.historyTrips ?? 0,
      suggestedBase: Math.max(0, qty),
      flags,
    });
  }
  return {
    lines,
    attention: lines.some((l) => l.flags.includes("depot_short"))
      ? ["The depot does not have enough for some products"]
      : [],
    facts: { copiedFrom: true },
  };
}

/** Wire the 20:00 Manila job. @param {any} core */
export function installNightly(core) {
  /** @param {{db:any}} ctx */
  const run = async ({ db }) => {
    const tomorrow = today(Date.now() + 24 * 3600 * 1000);
    // One transaction for the whole evening: each truck has its own savepoint inside it.
    const r = await tx(db, (/** @type {any} */ t) =>
      generateTrips(t, { day: tomorrow, by: SYSTEM.subject, trigger: "nightly" }),
    );
    if (r.planned || r.needsAttention) {
      // Each seller's phone gets the new trip on its next pull.
      await tx(db, async (/** @type {any} */ t) => {
        for (const row of r.trips)
          if (row.tripId && row.result.startsWith("planned")) {
            const [trip] = await t`select salesperson_profile_id from van_trips where id=${row.tripId}`;
            if (trip)
              await core.recordChange?.(t, {
                entity: "van.bundle",
                entityId: trip.salesperson_profile_id,
                scopeKey: `profile:${trip.salesperson_profile_id}`,
              });
          }
      });
      await core.publish("van");
    }
  };
  core.registerJob("van.nightly-plan", run);
  core.scheduler.daily("20:00", "Asia/Manila", "van.nightly-plan", run);
  return run;
}

/** POST van/must-carry/save {routeId?, unitId?, productId, minBase, active?}: the least a truck on this route carries of a product. @param {any} db @param {any} actor @param {any} p */
export async function saveMustCarry(db, actor, p) {
  await requireCapability({ db, actor }, "van.manage", p.unitId ?? null);
  const productId = uuid(p.productId);
  await productFor(db, productId);
  const route = p.routeId ? uuid(p.routeId) : null;
  const unit = p.unitId ? uuid(p.unitId) : null;
  await db`update van_must_carry set active=false where product_id=${productId} and active and coalesce(route_id,'00000000-0000-0000-0000-000000000000'::uuid)=${route ?? "00000000-0000-0000-0000-000000000000"}::uuid`;
  if (p.active === false) return { productId, removed: true };
  const min = Number(p.minBase);
  if (!Number.isSafeInteger(min) || min < 1) refuse("Enter how many pieces a truck must carry", "invalid_request");
  const [row] =
    await db`insert into van_must_carry(org_unit_id,route_id,product_id,min_base,set_by) values(${unit},${route},${productId},${min},${actor.subject}) returning id`;
  return { mustCarryId: row.id, productId };
}
