import { invalid } from "../../core/errors.js";
import { outletFor, tripFor, notSelf } from "./access.js";
import {
  audit,
  expectedStock,
  assertTruckStock,
  productFor,
  frozenProduct,
  explainStock,
} from "./facts.js";
import { routePolicy, temperatureAssessment } from "./route-policy.js";
import { uuid, text, choice, rows, integer, refuse } from "./model.js";
import { postMovement } from "../inventory/posting.js";
import { vanContainerBalances, containerHistory } from "./container-custody.js";
import { stopFacts } from "./callflow-config.js";
import { pickupManifest } from "./pickups.js";

export const ROUTE_OPS = [
  "temperature.record",
  "returnable.record",
  "unload.record",
  "reload.request",
  "stop.record",
];

/** F-114/F-115/F-116/F-121 immutable capture; core owns replay and rolls back rejected operations.
 * @param {any} db @param {any} trip @param {any} actor @param {any} device @param {any} p @param {any} op
 */
export async function recordRouteEvidence(db, trip, actor, device, p, op) {
  const id = uuid(p.observationId),
    at = p.deviceTime;
  const outlet = p.outletId
    ? await outletFor(db, actor, uuid(p.outletId))
    : null;
  let kind,
    facts,
    policy = null;
  if (op.opType === "stop.record") {
    kind = "stop";
    facts = await stopFacts(db, trip, outlet, p, at);
  } else if (op.opType === "temperature.record") {
    kind = "temperature";
    const checkpoint = choice(p.checkpoint, [
      "load_out",
      "interval",
      "delivery",
    ]);
    if ((checkpoint === "delivery") !== Boolean(outlet))
      throw invalid("Delivery readings need a store; other readings do not");
    if (
      trip.status === "planned" ||
      (checkpoint === "load_out" &&
        !["loading", "loaded"].includes(trip.status)) ||
      (checkpoint !== "load_out" && ["loading", "loaded"].includes(trip.status))
    )
      throw invalid(
        "Use the checkpoint appropriate to load-out or the active trip",
      );
    policy = await routePolicy(db, trip, "cold_chain", at);
    const products =
      await db`select distinct product_id from van_trip_load_lines where trip_id=${trip.id}`;
    const assessment = temperatureAssessment(
      policy.facts,
      p.deciC,
      products.map((/** @type {any} */ r) => r.product_id),
    );
    const [previous] =
      await db`select captured_at,facts from van_trip_observations where trip_id=${trip.id} and kind='temperature' and captured_at<=${new Date(at)} order by captured_at desc,id desc limit 1`;
    const gap = previous ? at - new Date(previous.captured_at).getTime() : 0;
    const interval = Math.min(
      policy.facts.intervalMinutes,
      previous?.facts.policy?.intervalMinutes ?? policy.facts.intervalMinutes,
    );
    facts = {
      checkpoint,
      deciC: p.deciC,
      unit: "C",
      method: choice(p.method, ["manual", "probe"]),
      note: text(p.note),
      policy: policy.facts,
      lateFromPrior: gap > interval * 60000,
      gapMinutes: Math.floor(gap / 60000),
      ...assessment,
    };
  } else if (op.opType === "returnable.record") {
    kind = "returnable";
    policy = await routePolicy(db, trip, "returnables", at);
    const type = policy.facts.items.find(
      (/** @type {any} */ i) => i.code === p.typeCode,
    );
    if (!type) throw invalid("Choose a configured crate or tray type");
    const action = choice(p.action, ["issue", "receive", "count"]),
      qty = integer(p.quantity, action !== "count");
    if (!outlet && action !== "count")
      throw invalid("Choose the store whose containers are changing");
    if (action === "issue") {
      const events = await containerHistory(db, trip.vehicle_id);
      const balance = vanContainerBalances(events).find(
        (r) => r.typeCode === type.code,
      );
      if (
        balance?.quantity === null ||
        balance?.quantity === undefined ||
        BigInt(balance.quantity) < qty
      )
        refuse("Count enough containers on the van before issuing them");
    }
    facts = {
      typeCode: type.code,
      label: type.label,
      action,
      quantity: String(qty),
      note: text(p.note),
    };
  } else if (op.opType === "unload.record") {
    kind = "unload";
    await requireTemperature(db, trip, at, "interval");
    const expected = await expectedStock(db, trip.id);
    await assertTruckStock(db, trip, expected);
    const lines = rows(p.lines, 2000),
      seen = new Set();
    for (const l of lines) {
      const key = `${l.productId}:${l.status}:${l.lotId ?? ""}`,
        e = expected.find(
          (e) => e.productId === l.productId && e.status === l.status,
        );
      if (!e || seen.has(key))
        refuse("Unload must match the final physical count", "stock_conflict");
      seen.add(key);
      choice(l.partition, ["unsold", "customer_return"]);
      if (l.lotId) uuid(l.lotId);
    }
    for (const e of expected)
      if (
        lines
          .filter((l) => l.productId === e.productId && l.status === e.status)
          .reduce((n, l) => n + integer(l.quantityBase), 0n) !==
          e.expectedBase ||
        !lines.some((l) => l.productId === e.productId && l.status === e.status)
      )
        throw invalid("Scan and count every unload line");
    const batches =
      await db`select b.*,l.lot_number,l.expires_at,l.quality_status from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id where b.location_id=${trip.truck_location_id} and b.stock_status in ('available','damaged')`;
    for (const b of batches) {
      const l = lines.find(
        (l) =>
          l.productId === b.product_id &&
          l.lotId === b.lot_id &&
          l.status === b.stock_status,
      );
      if (
        !l ||
        integer(l.quantityBase) !== BigInt(b.physical_base) ||
        l.batch !== b.lot_number ||
        l.expiresAt !==
          (b.expires_at ? new Date(b.expires_at).getTime() : null) ||
        l.qualityStatus !== b.quality_status
      )
        refuse("Unload must identify every counted batch", "stock_conflict");
    }
    for (const l of lines)
      if (
        l.lotId &&
        !batches.some(
          (/** @type {any} */ b) =>
            b.lot_id === l.lotId &&
            b.stock_status === l.status &&
            b.product_id === l.productId,
        )
      )
        throw invalid("Unload batch does not belong to this truck");
    const empties = Array.isArray(p.empties) ? p.empties : [];
    if (empties.length > 30) throw invalid("Too many container types");
    const van = vanContainerBalances(
      await containerHistory(db, trip.vehicle_id),
    );
    const assets = await routePolicy(db, trip, "returnables", at);
    const types = new Set();
    for (const e of empties) {
      text(e.typeCode, 32, true);
      integer(e.quantity);
      if (
        types.has(e.typeCode) ||
        !assets.facts.items.some(
          (/** @type {any} */ i) => i.code === e.typeCode,
        )
      )
        throw invalid("Choose every container type once");
      types.add(e.typeCode);
    }
    for (const item of assets.facts.items) {
      const held = van.find((v) => v.typeCode === item.code),
        scanned = empties.find(
          (/** @type {any} */ e) => e.typeCode === item.code,
        );
      if (
        !held ||
        held.quantity === null ||
        !scanned ||
        integer(scanned.quantity) !== BigInt(held.quantity)
      )
        refuse(
          "Physically count every configured container type before unload",
          "stock_conflict",
        );
      scanned.label = item.label;
    }
    const frozen = [];
    for (const l of lines)
      frozen.push({
        ...l,
        product: frozenProduct(await productFor(db, l.productId)),
      });
    const pickups = await pickupManifest(db, trip.id),
      supplied = p.pendingPickups ?? [];
    if (
      !Array.isArray(supplied) ||
      new Set(supplied).size !== supplied.length ||
      supplied.length !== pickups.length ||
      pickups.some((/** @type {string} */ id) => !supplied.includes(id))
    )
      refuse("Include each held pickup bag in the unload manifest");
    facts = {
      lines: frozen,
      empties,
      pendingPickups: pickups,
      note: text(p.note),
    };
  } else if (op.opType === "reload.request") {
    kind = "reload_request";
    const lines = rows(p.lines),
      seen = new Set();
    for (const l of lines) {
      uuid(l.productId);
      integer(l.quantityBase, true);
      if (seen.has(l.productId))
        throw invalid("Each requested SKU appears once");
      seen.add(l.productId);
      l.product = frozenProduct(await productFor(db, l.productId));
    }
    facts = { lines, note: text(p.note, 300, true) };
  } else throw invalid("Unsupported route observation");
  await db`insert into van_trip_observations(id,trip_id,client_op_id,kind,outlet_id,policy_id,captured_at,recorded_by,device_id,facts) values(${id},${trip.id},${op.clientOpId},${kind},${outlet?.id ?? null},${policy?.id ?? null},${new Date(at)},${actor.profileId},${device.id},${facts})`;
  return { entityId: id };
}

/** F-115 hard checkpoints without inventing an acceptable temperature or hiding an excursion.
 * @param {any} db @param {any} trip @param {number} at @param {string} checkpoint @param {string|null} [outletId]
 */
export async function requireTemperature(
  db,
  trip,
  at,
  checkpoint,
  outletId = null,
) {
  const policy = await routePolicy(db, trip, "cold_chain", at);
  if (
    checkpoint !== "interval" &&
    (
      await db`select 1 from van_trip_observations o left join van_observation_decisions d on d.observation_id=o.id where o.trip_id=${trip.id} and o.kind='temperature' and o.captured_at<=${new Date(at)} and (o.facts->>'excursion'='true' or o.facts->>'lateFromPrior'='true') and (d.id is null or d.decision<>'released') limit 1`
    ).length
  )
    refuse(
      "Resolve the cold-chain exception before departure or another sale",
      "evidence_pending_review",
    );
  const [last] =
    await db`select * from van_trip_observations where trip_id=${trip.id} and kind='temperature' and captured_at<=${new Date(at)} order by captured_at desc,id desc limit 1`;
  if (
    !last ||
    at - new Date(last.captured_at).getTime() >
      policy.facts.intervalMinutes * 60000 ||
    (checkpoint !== "interval" &&
      (last.facts.checkpoint !== checkpoint || last.outlet_id !== outletId))
  )
    refuse(
      "Record the required cold-chain temperature before continuing",
      "evidence_pending_review",
    );
}

/** F-115/F-116 office receipt is separate from a seller's local completion. @param {any} db @param {any} actor @param {any} p */
export async function decideObservation(db, actor, p) {
  const trip = await tripFor(
    db,
    actor,
    uuid(p.tripId),
    "van.stock.approve",
    true,
  );
  notSelf(actor, trip);
  const [o] =
    await db`select * from van_trip_observations where id=${uuid(p.observationId)} and trip_id=${trip.id}`;
  if (!o || !["temperature", "unload"].includes(o.kind))
    throw invalid("Choose a temperature review or unload");
  if (
    (
      await db`select 1 from van_observation_decisions where observation_id=${o.id}`
    ).length
  )
    refuse("This evidence already has a decision");
  const note = text(p.note, 300, true);
  let movementId = null,
    facts = { note };
  const decision =
    o.kind === "temperature"
      ? choice(p.decision, ["released", "quarantine"])
      : choice(p.decision, ["received"]);
  if (o.kind === "unload") {
    if (
      (
        await db`select 1 from van_observation_decisions d join van_trip_observations t on t.id=d.observation_id where t.trip_id=${trip.id} and t.kind='temperature' and d.decision='quarantine'`
      ).length
    )
      refuse(
        "Quarantined goods require the warehouse quality-disposition workflow; do not receive them as sellable stock",
        "evidence_pending_review",
      );
    if (
      !(await db`select 1 from van_settlements where trip_id=${trip.id}`).length
    )
      refuse(
        "Sync the locally completed settlement before recording warehouse receipt",
      );
    const lines = rows(p.lines, 2000);
    if (lines.length !== o.facts.lines.length)
      throw invalid("Receive every unload line");
    const seen = new Set();
    const postings = [],
      explanations = [];
    for (const l of lines) {
      const key = `${l.productId}:${l.status}:${l.lotId ?? ""}`,
        e = o.facts.lines.find(
          (/** @type {any} */ e) =>
            e.productId === l.productId &&
            e.status === l.status &&
            (e.lotId ?? null) === (l.lotId ?? null),
        );
      if (!e || seen.has(key))
        throw invalid("Unload line is missing or repeated");
      seen.add(key);
      const qty = integer(l.receivedBase),
        expected = integer(e.quantityBase);
      if (qty > expected)
        throw invalid(
          "Receive no more than scanned; recount excess separately",
        );
      if (qty !== expected) text(l.reason, 300, true);
      if (qty) {
        postings.push({
          productId: l.productId,
          fromLocationId: trip.truck_location_id,
          toLocationId: trip.source_location_id,
          quantityBase: Number(qty),
          stockStatus: e.status,
          uom: e.product.uomCode,
          lotId: e.lotId ?? null,
        });
        explanations.push({
          productId: l.productId,
          status: e.status,
          delta: -qty,
          facts: e.product,
        });
      }
    }
    if (postings.length)
      movementId = (
        await postMovement(db, {
          kind: "van_unload",
          sourceType: "van_unload_receipt",
          sourceId: o.id,
          idempotencyKey: `van:receive:${o.id}`,
          occurredAt: Date.now(),
          actor: { profileId: actor.profileId, userId: actor.userId },
          organizationId: trip.organization_id,
          authorizedLocations: [
            trip.truck_location_id,
            trip.source_location_id,
          ],
          lines: postings,
        })
      ).movementId;
    await explainStock(db, trip, o.id, "unload", explanations);
    const empties = Array.isArray(p.empties) ? p.empties : [],
      seenAssets = new Set();
    if (empties.length !== (o.facts.empties ?? []).length)
      throw invalid("Count every returned empty container type");
    let discrepancy = false;
    for (const e of empties) {
      const expected = o.facts.empties.find(
        (/** @type {any} */ i) => i.typeCode === e.typeCode,
      );
      if (!expected || seenAssets.has(e.typeCode))
        throw invalid("Unknown or repeated container receipt");
      seenAssets.add(e.typeCode);
      const q = integer(e.quantity);
      if (q !== integer(expected.quantity)) discrepancy = true;
      e.label = expected.label;
    }
    facts = {
      note,
      .../** @type {any} */ ({
        lines,
        empties,
        discrepancy:
          discrepancy ||
          lines.some(
            (l) =>
              integer(l.receivedBase) !==
              integer(
                o.facts.lines.find(
                  (/** @type {any} */ e) =>
                    e.productId === l.productId &&
                    e.status === l.status &&
                    (e.lotId ?? null) === (l.lotId ?? null),
                ).quantityBase,
              ),
          ),
      }),
    };
  }
  await db`insert into van_observation_decisions(observation_id,decision,facts,actor_profile_id,movement_id) values(${o.id},${decision},${facts},${actor.profileId},${movementId})`;
  await audit(db, trip, actor, `van.${o.kind}.${decision}`, o.id, { note });
  return { tripId: trip.id, observationId: o.id, movementId };
}

/** F-114 outstanding custody is derived, never a second stock balance writer. @param {any[]} events */
export function containerBalances(events) {
  /** @type {Map<string,any>} */ const result = new Map();
  for (const e of events) {
    const f = e.facts,
      key = `${e.outlet_id}:${f.typeCode}`,
      r = result.get(key) ?? {
        outletId: e.outlet_id,
        typeCode: f.typeCode,
        label: f.label,
        outstanding: 0n,
        lastCount: null,
      };
    const qty = BigInt(f.quantity);
    if (f.action === "issue") r.outstanding += qty;
    if (f.action === "receive") r.outstanding -= qty;
    if (f.action === "count") r.lastCount = String(qty);
    result.set(key, r);
  }
  return [...result.values()].map((r) => ({
    ...r,
    outstanding: String(r.outstanding),
  }));
}
