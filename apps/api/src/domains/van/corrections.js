import { canonicalJson, sha256Hex } from "../../core/util.js";
import { actorFor } from "../../core/context.js";
import { requireCapability } from "../../core/capabilities.js";
import { tripFor, notSelf, currentActor } from "./access.js";
import { uuid, text, integer, safeNumber, refuse } from "./model.js";
import { audit, explainStock, expectedStock } from "./facts.js";
import { postMovement } from "../inventory/posting.js";
import { routePolicy } from "./route-policy.js";
const receiptKey = (/** @type {any} */ l) => `${key(l)}:${l.partition ?? ""}`;
const hash = (/** @type {any} */ v) => sha256Hex(canonicalJson(v));
const key = (/** @type {any} */ l) =>
  `${l.productId}:${l.status}:${l.lotId ?? ""}`;
/** @param {any} db @param {string} tripId */
export async function approvedCorrections(db, tripId) {
  return db`select c.*,d.movement_id from van_reconciliation_changes c join van_reconciliation_decisions d on d.change_id=c.id and d.decision='approved' where c.trip_id=${tripId} order by d.created_at,c.id`;
}
/** F-116 actual partial receipt plus explicitly approved supplemental facts.
 * @param {any} db @param {string} tripId */
export async function unloadBasis(db, tripId) {
  const [o] =
    await db`select o.id,o.facts,d.facts as received from van_trip_observations o join van_observation_decisions d on d.observation_id=o.id and d.decision='received' where o.trip_id=${tripId} and o.kind='unload'`;
  if (!o) refuse("Record the first warehouse receipt before correcting it");
  const corrections = (await approvedCorrections(db, tripId)).filter(
    (/** @type {any} */ c) => c.kind !== "cash_recount",
  );
  const lines = o.facts.lines.map((/** @type {any} */ l) => {
    const first = o.received.lines.find(
      (/** @type {any} */ x) => receiptKey(x) === receiptKey(l),
    );
    const received =
      BigInt(first?.receivedBase ?? 0) +
      corrections.reduce(
        (/** @type {bigint} */ n, /** @type {any} */ c) =>
          n +
          BigInt(
            c.facts.lines?.find(
              (/** @type {any} */ x) => receiptKey(x) === receiptKey(l),
            )?.quantityBase ?? 0,
          ),
        0n,
      );
    const remaining = BigInt(l.quantityBase) - received;
    if (remaining < 0n)
      refuse("Warehouse corrections exceed the scanned stock");
    return { ...l, quantityBase: String(remaining) };
  });
  const empties = (o.facts.empties ?? []).map((/** @type {any} */ e) => {
    const received =
      BigInt(
        o.received.empties?.find(
          (/** @type {any} */ x) => x.typeCode === e.typeCode,
        )?.quantity ?? 0,
      ) +
      corrections.reduce(
        (/** @type {bigint} */ n, /** @type {any} */ c) =>
          n +
          BigInt(
            c.facts.empties?.find(
              (/** @type {any} */ x) => x.typeCode === e.typeCode,
            )?.quantity ?? 0,
          ),
        0n,
      );
    const remaining = BigInt(e.quantity) - received;
    if (remaining < 0n)
      refuse("Container corrections exceed the scanned custody");
    return { ...e, quantity: String(remaining) };
  });
  return {
    observationId: o.id,
    lines,
    empties,
    correctionIds: corrections.map((/** @type {any} */ c) => c.id),
  };
}
/** @param {any} db @param {string} tripId */
export async function effectiveCash(db, tripId) {
  const [count] =
    await db`select * from van_cash_counts where trip_id=${tripId}`;
  const [receipt] =
    await db`select * from van_cash_remittances where trip_id=${tripId}`;
  const cashChanges = (await approvedCorrections(db, tripId)).filter(
    (/** @type {any} */ c) => c.kind === "cash_recount",
  );
  const superseded = new Set(
    cashChanges.map((/** @type {any} */ c) => c.facts.basis.correctionId),
  );
  const leaves = cashChanges.filter(
    (/** @type {any} */ c) => !superseded.has(c.id),
  );
  if (leaves.length > 1)
    refuse(
      "Ambiguous cash correction chain; retain the original evidence for review",
    );
  const latest = leaves[0];
  return {
    countId: count?.id ?? null,
    declaredMinor:
      latest?.facts.newDeclaredMinor ??
      (count ? String(count.declared_centavos) : null),
    receivedMinor:
      latest?.facts.newReceivedMinor ??
      (receipt ? String(receipt.amount_centavos) : null),
    receiptId: receipt?.id ?? null,
    correctionId: latest?.id ?? null,
  };
}
/** @param {any} db @param {any} actor @param {any} p */
export async function requestCorrection(db, actor, p) {
  const kind = p.kind;
  if (
    ![
      "unload_remainder",
      "adjustment_reference",
      "empties_loss",
      "cash_recount",
    ].includes(kind)
  )
    refuse("Choose a supported correction");
  const trip = await tripFor(
    db,
    actor,
    uuid(p.tripId),
    kind === "cash_recount" ? "van.cash.approve" : "van.stock.approve",
    true,
  );
  notSelf(actor, trip);
  if (["closed", "cancelled"].includes(trip.status))
    refuse(
      "Final trips require a new accounting adjustment, not a rewritten settlement",
    );
  /** @type {any} */
  const basis =
    kind === "cash_recount"
      ? await effectiveCash(db, trip.id)
      : await unloadBasis(db, trip.id);
  let facts;
  if (kind === "cash_recount") {
    if (!basis.countId) refuse("A captured cash count is required");
    facts = {
      basis,
      newDeclaredMinor: String(integer(p.newDeclaredMinor)),
      newReceivedMinor: basis.receiptId
        ? String(integer(p.newReceivedMinor))
        : null,
      reference: text(p.reference, 100, true),
    };
  } else {
    const b = /** @type {any} */ (basis);
    const lines =
      kind === "empties_loss"
        ? []
        : b.lines.filter((/** @type {any} */ l) => BigInt(l.quantityBase) > 0n);
    const empties =
      kind === "adjustment_reference"
        ? []
        : b.empties.filter((/** @type {any} */ e) => BigInt(e.quantity) > 0n);
    if (!lines.length && !empties.length)
      refuse("There is no unresolved quantity for this correction");
    facts = {
      basis,
      lines,
      empties,
      movementNumber:
        kind === "adjustment_reference"
          ? text(p.movementNumber, 100, true)
          : null,
      valueMinor: kind === "empties_loss" ? null : "0",
    };
  }
  const id = uuid(p.id ?? crypto.randomUUID());
  await db`insert into van_reconciliation_changes(id,trip_id,kind,basis_hash,facts,reason,requested_by,requested_role) values(${id},${trip.id},${kind},${hash(basis)},${facts},${text(p.reason, 300, true)},${actor.profileId},${actor.role})`;
  await audit(db, trip, actor, "van.correction.request", id, { kind });
  return { tripId: trip.id, changeId: id };
}
/** F-116/F-117 the second person applies exact current facts; no receipt/count is edited.
 * @param {any} db @param {any} actor @param {any} p */
export async function decideCorrection(db, actor, p) {
  const [c] =
    await db`select * from van_reconciliation_changes where id=${uuid(p.changeId)} for update`;
  if (!c) refuse("Correction not found");
  const cap =
    c.kind === "cash_recount" ? "van.cash.approve" : "van.stock.approve";
  const trip = await tripFor(db, actor, c.trip_id, cap, true);
  notSelf(actor, trip);
  if (actor.profileId === c.requested_by)
    refuse("A different person must approve this correction");
  if (["closed", "cancelled"].includes(trip.status))
    refuse("The trip is final");
  if (
    (
      await db`select 1 from van_reconciliation_decisions where change_id=${c.id}`
    ).length
  )
    refuse("Correction already decided");
  const decision = p.decision;
  if (!["approved", "rejected"].includes(decision))
    refuse("Approve or reject the correction");
  let movementId = null;
  if (decision === "approved") {
    const [profile] =
      await db`select user_id from profiles where id=${c.requested_by}`;
    const requester = profile
      ? await currentActor(db, await actorFor(db, profile.user_id))
      : null;
    if (!requester || requester.role !== c.requested_role)
      refuse("The requester authority changed");
    await requireCapability({ db, actor: requester }, cap, trip.org_unit_id);
    const basis =
      c.kind === "cash_recount"
        ? await effectiveCash(db, trip.id)
        : await unloadBasis(db, trip.id);
    if (hash(basis) !== c.basis_hash)
      refuse("Receipt or count changed; prepare a fresh correction");
    if (c.kind === "unload_remainder") {
      if (c.facts.lines.length)
        movementId = (
          await postMovement(db, {
            organizationId: trip.organization_id,
            kind: "van_unload",
            sourceType: "van_unload_correction",
            sourceId: c.id,
            idempotencyKey: `van:unload-correction:${c.id}`,
            occurredAt: Date.now(),
            actor: { profileId: actor.profileId, userId: actor.userId },
            authorizedLocations: [
              trip.truck_location_id,
              trip.source_location_id,
            ],
            lines: c.facts.lines.map((/** @type {any} */ l) => ({
              productId: l.productId,
              fromLocationId: trip.truck_location_id,
              toLocationId: trip.source_location_id,
              quantityBase: safeNumber(BigInt(l.quantityBase)),
              stockStatus: l.status,
              uom: l.product.uomCode,
              lotId: l.lotId ?? null,
            })),
          })
        ).movementId;
    } else if (c.kind === "adjustment_reference") {
      const [m] =
        await db`select m.* from inventory_movements m join inventory_adjustments a on a.movement_id=m.id and a.status='posted' where m.movement_number=${c.facts.movementNumber} and m.organization_id=${trip.organization_id} and m.status='posted' and m.movement_type='inventory_adjustment' and m.source_type='inventory_adjustment' limit 1`;
      if (!m || m.posted_by === trip.salesperson_subject)
        refuse(
          "Reference an independently approved posted inventory adjustment",
        );
      const lines =
        await db`select l.*,a.lot_id,a.quantity_base as part_quantity from inventory_movement_lines l left join inventory_allocations a on a.movement_line_id=l.id where l.movement_id=${m.id}`;
      const totals = new Map();
      for (const l of lines) {
        if (
          l.from_location_id !== trip.truck_location_id ||
          l.to_location_id !== null
        )
          refuse("Adjustment must remove only the unresolved truck shortage");
        const k = key({
          productId: l.product_id,
          status: l.from_stock_status,
          lotId: l.lot_id,
        });
        totals.set(
          k,
          (totals.get(k) ?? 0n) + BigInt(l.part_quantity ?? l.quantity_base),
        );
      }
      const wanted = new Map();
      for (const l of c.facts.lines)
        wanted.set(key(l), (wanted.get(key(l)) ?? 0n) + BigInt(l.quantityBase));
      if (
        totals.size !== wanted.size ||
        [...wanted].some(([k, v]) => totals.get(k) !== v)
      )
        refuse("Adjustment quantities/lots must exactly match this shortage");
      movementId = m.id;
    }
    if (c.kind === "unload_remainder" || c.kind === "adjustment_reference")
      await explainStock(
        db,
        trip,
        c.id,
        c.kind === "unload_remainder" ? "unload" : "warehouse_loss",
        [
          ...c.facts.lines
            .reduce(
              (/** @type {Map<string,any>} */ m, /** @type {any} */ l) => {
                const k = `${l.productId}:${l.status}`,
                  row = m.get(k) ?? {
                    productId: l.productId,
                    status: l.status,
                    delta: 0n,
                    facts: l.product,
                  };
                row.delta -= BigInt(l.quantityBase);
                m.set(k, row);
                return m;
              },
              new Map(),
            )
            .values(),
        ],
      );
  }
  await db`insert into van_reconciliation_decisions(change_id,decision,actor_profile_id,reason,movement_id) values(${c.id},${decision},${actor.profileId},${text(p.reason, 300, true)},${movementId})`;
  await audit(db, trip, actor, `van.correction.${decision}`, c.id, {
    kind: c.kind,
  });
  return { tripId: trip.id, changeId: c.id, movementId };
}
/** @param {any} db @param {any} actor @param {string} tripId */
export async function correctionQueue(db, actor, tripId) {
  await tripFor(db, actor, uuid(tripId));
  const items =
    await db`select c.id,c.kind,c.facts,c.reason,p.name as "requestedBy",d.decision,q.name as "decidedBy" from van_reconciliation_changes c join profiles p on p.id=c.requested_by left join van_reconciliation_decisions d on d.change_id=c.id left join profiles q on q.id=d.actor_profile_id where c.trip_id=${tripId} order by c.created_at,c.id limit 501`;
  if (items.length > 500) refuse("Too many corrections for one trip");
  return { items };
}
/** F-117 rejected versions can be rebuilt from retained facts and approved corrections, never edited in place.
 * @param {any} db @param {any} actor @param {any} p */
export async function reviseSettlement(db, actor, p) {
  const trip = await tripFor(
    db,
    actor,
    uuid(p.tripId),
    "van.stock.approve",
    true,
  );
  notSelf(actor, trip);
  const [old] =
    await db`select s.*,d.decision from van_settlements s left join van_settlement_decisions d on d.settlement_id=s.id where s.trip_id=${trip.id} order by s.version desc limit 1`;
  if (
    !old ||
    old.decision !== "rejected" ||
    old.content_hash !== p.contentHash ||
    hash(old.facts) !== old.content_hash
  )
    refuse(
      "Choose the unchanged rejected version; final approved versions are never reopened",
    );
  const cash = await effectiveCash(db, trip.id),
    changes = await approvedCorrections(db, trip.id);
  const facts = {
    ...old.facts,
    previousVersion: old.version,
    previousContentHash: old.content_hash,
    corrections: changes.map((/** @type {any} */ c) => ({
      id: c.id,
      kind: c.kind,
      reason: c.reason,
      facts: c.facts,
    })),
    note: text(p.reason, 300, true),
  };
  if (cash.declaredMinor !== null) {
    const abs = (/** @type {bigint} */ v) => (v < 0n ? -v : v);
    const before = BigInt(old.facts.cash.varianceCentavos),
      after =
        BigInt(cash.declaredMinor) - BigInt(old.facts.cash.expectedCentavos);
    facts.cash = {
      ...old.facts.cash,
      declaredCentavos: cash.declaredMinor,
      varianceCentavos: String(after),
      receiptCentavos: cash.receivedMinor,
    };
    facts.varianceCentavos =
      old.facts.varianceCentavos === null
        ? null
        : String(BigInt(old.facts.varianceCentavos) - abs(before) + abs(after));
  }
  const unseen = changes.filter(
    (/** @type {any} */ c) =>
      !(old.facts.corrections ?? []).some(
        (/** @type {any} */ x) => x.id === c.id,
      ),
  );
  if (
    unseen.some((/** @type {any} */ c) =>
      ["adjustment_reference", "empties_loss"].includes(c.kind),
    )
  )
    facts.varianceCentavos = null; // SAP valuation/recovery must be reviewed, never assumed zero.
  facts.closing = (await expectedStock(db, trip.id)).map((e) => ({
    productId: e.productId,
    status: e.status,
    quantityBase: String(e.expectedBase),
  }));
  const policy = await routePolicy(db, trip, "variance", Date.now());
  facts.toleranceBasisPoints = policy.facts.toleranceBasisPoints;
  facts.breach =
    facts.varianceCentavos === null ||
    BigInt(facts.varianceCentavos) * 10000n >
      BigInt(facts.salesCentavos) * BigInt(facts.toleranceBasisPoints);
  const id = crypto.randomUUID();
  await db`insert into van_settlements(id,trip_id,version,content_hash,facts,submitted_by,captured_at) values(${id},${trip.id},${old.version + 1},${hash(facts)},${facts},${actor.profileId},now())`;
  if (facts.breach)
    await db`insert into van_variance_cases(settlement_id,policy_id,sales_centavos,variance_centavos,tolerance_basis_points,level,due_at) values(${id},${policy.id},${facts.salesCentavos},${facts.varianceCentavos},${facts.toleranceBasisPoints},'supervisor',now()+${policy.facts.escalateAfterHours}*interval '1 hour')`;
  await audit(db, trip, actor, "van.settlement.revised", id, {
    previousVersion: old.version,
  });
  return { tripId: trip.id, settlementId: id, version: old.version + 1 };
}
