import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { recordChange } from "../../core/sync.js";
import { enqueueRefresh } from "../analytics/refresh.js";
import {
  audit,
  choice,
  document,
  gateTransfer,
  id,
  integer,
  invalid,
  lines,
  locationGate,
  manilaDate,
  notSelf,
  ORGANIZATION,
  productPolicy,
  state,
  STATUSES,
  STATUS_FIELDS,
  stockLock,
  text,
} from "./common.js";
import { postMovement } from "./posting.js";
import { enforceInventoryAuthority } from "./fiscal.js";

/** @typedef {import('./posting.js').MovementLine} MovementLine */
/** @typedef {{cap:string, prepare:(c:any,b:any)=>Promise<any>, run:(c:any,b:any,prepared:any)=>Promise<any>}} Command */
/** @type {Record<string,Command>} */
export const commands = {};
/** @param {any} ctx @param {string} action */
export async function execute(ctx, action) {
  const spec = commands[action];
  if (!spec) throw new ApiError("not_found", 404, "Stock action not found");
  const body = ctx.body;
  if (!body || typeof body !== "object" || Array.isArray(body))
    invalid("Supply a command object");
  const key = text(body.idempotencyKey, "Idempotency key", 200);
  const result = await tx(ctx.db, async (t) => {
    await stockLock(t, ORGANIZATION);
    const actor = ctx.actor ? await actorFor(t, ctx.actor.userId) : null;
    const c = { ...ctx, db: t, actor };
    await requireCapability(c, spec.cap);
    await t`select set_config('sunpride.actor',${actor?.userId ?? "system:inventory"},true)`;
    const prepared = await spec.prepare(c, body); // persisted scope before replay, every time
    const hash = sha256Hex(canonicalJson({ action, body }));
    const [prior] =
      await t`select * from inventory_action_receipts where organization_id=${ORGANIZATION} and idempotency_key=${key}`;
    if (prior) {
      if (prior.payload_hash !== hash || prior.actor_user_id !== actor?.userId)
        throw new ApiError(
          "idempotency_conflict",
          409,
          "This key already belongs to different work",
        );
      return { ...prior.result, duplicate: true };
    }
    const value = await spec.run(c, body, prepared);
    await audit(t, actor, action, value.id ?? value.movementId ?? "settings");
    await t`insert into inventory_action_receipts (organization_id,idempotency_key,action,payload_hash,actor_user_id,result) values (${ORGANIZATION},${key},${action},${hash},${actor?.userId},${value})`;
    return { ...value, duplicate: false };
  });
  await ctx.publish("inventory");
  await enqueueRefresh(ctx, {
    kind: "stock",
    date: manilaDate(ctx.now),
    unitId: ctx.actor?.orgUnitId ?? null,
  });
  return result;
}
/** @param {any} c @param {any} b @param {string} kind @param {string} sourceType @param {string} sourceId @param {MovementLine[]} postingLines */
export const post = (c, b, kind, sourceType, sourceId, postingLines) =>
  postMovement(c.db, {
    kind,
    sourceType,
    sourceId,
    idempotencyKey: `posting:${b.idempotencyKey}`,
    occurredAt: c.now,
    actor: { profileId: c.actor.profileId, userId: c.actor.userId },
    organizationId: ORGANIZATION,
    lines: postingLines,
    ...(c.authorizedLocations
      ? { authorizedLocations: c.authorizedLocations }
      : {}),
    ...(b.note ? { note: b.note } : {}),
  });
/** @param {any} c @param {any} b */
const lineGates = async (c, b) => {
  for (const l of lines(b.lines)) {
    await locationGate(c, "inventory.write", id(l.locationId));
    await productPolicy(c.db, id(l.productId));
  }
};
/** @param {any} c @param {string} capability @param {any[]} rows */
async function gateLines(c, capability, rows) {
  if (!rows.length || rows.length > 100) invalid("Supply 1–100 lines");
  for (const l of rows)
    await locationGate(c, capability, l.location_id ?? l.locationId);
}
/** @param {any} c @param {any} row @param {string} cap */
async function adjustmentGate(c, row, cap) {
  const rows =
    await c.db`select * from inventory_adjustment_lines where adjustment_id=${row.id} order by id`;
  if (!rows.length && row.source_count_id) {
    const count = await document(
      c.db,
      "stock_count_sessions",
      row.source_count_id,
    );
    await locationGate(c, cap, count.location_id);
  } else await gateLines(c, cap, rows);
  return rows;
}
/** @param {any} row @param {string} locationId @returns {MovementLine} */
function varianceLine(row, locationId) {
  const v = Number(row.variance_base);
  return {
    productId: row.product_id,
    quantityBase: Math.abs(v),
    uom: "base",
    fromLocationId: v < 0 ? locationId : null,
    toLocationId: v > 0 ? locationId : null,
    stockStatus: row.stock_status,
    lotId: row.lot_id,
    ...(row.unit_cost_minor != null
      ? { unitCostMinor: Number(row.unit_cost_minor) }
      : {}),
  };
}

commands["locations/save"] = {
  cap: "inventory.write",
  prepare: async (c, b) => {
    await requireNationalScope(c, ["admin"]);
    id(b.orgUnitId, "Organizational unit");
    await requireCapability(c, "inventory.write", b.orgUnitId);
    const [unit] =
      await c.db`select id from org_units where id=${b.orgUnitId} and organization_id=${ORGANIZATION} and status='active' and deleted_at is null`;
    if (!unit) invalid("Choose an active organizational unit");
    if (b.id) {
      const existing = await document(c.db, "inventory_locations", id(b.id));
      if (existing.org_unit_id)
        return locationGate(c, "inventory.write", existing.id);
      if (existing.deleted_at)
        throw new ApiError("not_found", 404, "Stock location not found");
      return existing; // the national gate above is the recovery path for unmapped stock
    }
    return null;
  },
  run: async (c, b, existing) => {
    const type = choice(b.type, [
      "warehouse",
      "zone",
      "bin",
      "production",
      "wip",
      "truck",
      "in_transit",
      "returns",
      "virtual_boundary",
      "store",
    ]);
    if (b.parentLocationId) {
      const parent = await locationGate(
        c,
        "inventory.write",
        id(b.parentLocationId),
      );
      if (parent.id === b.id) invalid("A location cannot contain itself");
      const descendants =
        await c.db`with recursive tree as (select id,parent_location_id from inventory_locations where id=${b.parentLocationId} union select p.id,p.parent_location_id from inventory_locations p join tree t on p.id=t.parent_location_id) select id from tree`;
      if (descendants.some((/** @type {any} */ r) => r.id === b.id))
        invalid("Location hierarchy would contain a cycle");
    }
    const locationId = existing?.id ?? crypto.randomUUID();
    if (
      existing &&
      ((existing.org_unit_id && existing.org_unit_id !== b.orgUnitId) ||
        b.active === false ||
        existing.type !== type)
    ) {
      const [r] =
        await c.db`select 1 from inventory_balances where location_id=${locationId} and (physical_base<>0 or reserved_base<>0) limit 1`;
      if (r) invalid("Move stock out before changing location ownership");
    }
    await c.db`insert into inventory_locations (id,organization_id,org_unit_id,site_code,parent_location_id,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production)
    values (${locationId},${ORGANIZATION},${b.orgUnitId},${text(b.siteCode ?? "MAIN", "Site", 40)},${b.parentLocationId ?? null},${text(b.code, "Code", 60)},${text(b.name, "Name", 160)},${type},${b.active !== false},${b.allowsPicking !== false},${b.allowsReceiving !== false},${b.allowsSale === true},false)
    on conflict(id) do update set org_unit_id=excluded.org_unit_id,site_code=excluded.site_code,parent_location_id=excluded.parent_location_id,code=excluded.code,name=excluded.name,type=excluded.type,active=excluded.active,allows_picking=excluded.allows_picking,allows_receiving=excluded.allows_receiving,allows_sale=excluded.allows_sale`;
    await recordChange(c.db, {
      entity: "inventory_locations",
      entityId: locationId,
      scopeKey: b.orgUnitId,
      op: "upsert",
    });
    return { id: locationId };
  },
};

commands["receipts/post"] = {
  cap: "inventory.write",
  prepare: async (c, b) =>
    locationGate(c, "inventory.write", id(b.receivingLocationId)),
  run: async (c, b, loc) => {
    if (!loc.allows_receiving || !loc.active)
      invalid("This location cannot receive stock");
    const receiptId = crypto.randomUUID();
    const receiptType = choice(
      b.receiptType,
      ["purchase_order", "transfer", "return", "unplanned"],
      "unplanned",
    );
    await c.db`insert into goods_receipts (id,organization_id,receipt_number,receipt_type,receiving_location_id,status,delivery_reference,received_by,note) values (${receiptId},${ORGANIZATION},${`GR-${receiptId.slice(0, 8).toUpperCase()}`},${receiptType},${loc.id},'in_inspection',${b.deliveryReference ?? null},${c.actor.userId},${b.note ?? null})`;
    /** @type {MovementLine[]} */ const postingLines = [];
    for (const l of lines(b.lines)) {
      integer(l.quantityBase, "Accepted quantity", 1);
      integer(l.rejectedBase ?? 0, "Rejected quantity");
      const { product, policy, tracking } = await productPolicy(
        c.db,
        id(l.productId),
      );
      let lotId = null;
      if (tracking === "lot") {
        const lotNumber = text(l.lotNumber, "Lot number", 100),
          normalized = lotNumber.toUpperCase();
        if (policy?.expiry_date_required && l.expiresAt == null)
          invalid("This product requires an expiry date");
        if (policy?.manufacture_date_required && l.manufacturedAt == null)
          invalid("This product requires a manufacture date");
        if (l.expiresAt != null) integer(l.expiresAt, "Expiry date", 1);
        if (l.manufacturedAt != null)
          integer(l.manufacturedAt, "Manufacture date", 1);
        if (
          l.expiresAt &&
          (l.expiresAt <= c.now ||
            (l.manufacturedAt && l.expiresAt <= l.manufacturedAt))
        )
          invalid("Expiry must follow receipt and manufacture");
        const [old] =
          await c.db`select * from inventory_lots where organization_id=${ORGANIZATION} and product_id=${product.id} and normalized_lot_number=${normalized} for update`;
        if (old) {
          if (
            (old.expires_at ? new Date(old.expires_at).getTime() : null) !==
              (l.expiresAt ?? null) ||
            (old.manufactured_at
              ? new Date(old.manufactured_at).getTime()
              : null) !== (l.manufacturedAt ?? null) ||
            ["expired", "rejected"].includes(old.quality_status)
          )
            invalid(
              "The lot's dates or quality conflict with the existing lot",
            );
          lotId = old.id;
        } else {
          const [lot] =
            await c.db`insert into inventory_lots (organization_id,product_id,lot_number,normalized_lot_number,source_type,source_document_id,received_at,manufactured_at,expires_at,quality_status,unit_cost_minor) values (${ORGANIZATION},${product.id},${lotNumber},${normalized},${receiptType},${receiptId},${new Date(c.now)},${l.manufacturedAt ? new Date(l.manufacturedAt) : null},${l.expiresAt ? new Date(l.expiresAt) : null},${policy?.quality_release_required ? "pending" : "released"},${l.unitCostMinor ?? null}) returning id`;
          lotId = lot.id;
        }
      }
      const destinationStatus = policy?.quality_release_required
        ? "quality_hold"
        : "available";
      for (const [qty, status] of [
        [l.quantityBase, destinationStatus],
        [l.rejectedBase ?? 0, "rejected"],
      ])
        if (qty)
          postingLines.push({
            productId: product.id,
            quantityBase: Number(qty),
            uom: product.uom,
            fromLocationId: null,
            toLocationId: loc.id,
            stockStatus: String(status),
            lotId,
            ...(l.unitCostMinor != null
              ? { unitCostMinor: integer(l.unitCostMinor, "Cost") }
              : {}),
          });
      await c.db`insert into goods_receipt_lines (organization_id,receipt_id,product_id,accepted_base,rejected_base,lot_id,destination_status,unit_cost_minor) values (${ORGANIZATION},${receiptId},${product.id},${l.quantityBase},${l.rejectedBase ?? 0},${lotId},${destinationStatus},${l.unitCostMinor ?? null})`;
    }
    const movement = await post(
      c,
      b,
      c.openingStock ? "opening_balance" : "goods_receipt",
      c.openingStock ? "cutover" : "goods_receipt",
      receiptId,
      postingLines,
    );
    await c.db`update goods_receipts set status='posted',movement_id=${movement.movementId} where id=${receiptId}`;
    return { id: receiptId, ...movement };
  },
};

commands["transfers/request"] = {
  cap: "inventory.write",
  prepare: async (c, b) => {
    for (const k of [
      "sourceLocationId",
      "destinationLocationId",
      "inTransitLocationId",
    ])
      await locationGate(c, "inventory.write", id(b[k]));
    return null;
  },
  run: async (c, b) => {
    if (
      new Set([
        b.sourceLocationId,
        b.destinationLocationId,
        b.inTransitLocationId,
      ]).size !== 3
    )
      invalid("Source, destination and transit locations must differ");
    const transit = await locationGate(
      c,
      "inventory.write",
      b.inTransitLocationId,
    );
    if (transit.type !== "in_transit") invalid("Choose an in-transit location");
    const source = await locationGate(c, "inventory.write", b.sourceLocationId),
      dest = await locationGate(c, "inventory.write", b.destinationLocationId);
    if (
      !source.active ||
      !dest.active ||
      !source.allows_picking ||
      !dest.allows_receiving
    )
      invalid("Source must allow picking and destination must allow receiving");
    const transferId = crypto.randomUUID();
    await c.db`insert into stock_transfers (id,organization_id,transfer_number,source_location_id,destination_location_id,in_transit_location_id,status,requested_by,note) values (${transferId},${ORGANIZATION},${`TR-${transferId.slice(0, 8).toUpperCase()}`},${b.sourceLocationId},${b.destinationLocationId},${b.inTransitLocationId},'requested',${c.actor.userId},${b.note ?? null})`;
    const seen = new Set();
    for (const l of lines(b.lines)) {
      await productPolicy(c.db, id(l.productId));
      if (seen.has(l.productId)) invalid("Use one transfer line per product");
      seen.add(l.productId);
      integer(l.quantityBase, "Transfer quantity", 1);
      await c.db`insert into stock_transfer_lines (organization_id,transfer_id,product_id,requested_base,approved_base,shipped_base,received_base,rejected_base,short_base) values (${ORGANIZATION},${transferId},${l.productId},${l.quantityBase},0,0,0,0,0)`;
    }
    return { id: transferId };
  },
};
for (const action of ["approve", "ship", "receive", "cancel"])
  commands[`transfers/${action}`] = {
    cap: ["approve", "cancel"].includes(action)
      ? "inventory.approve"
      : "inventory.write",
    prepare: async (c, b) => {
      const row = await document(c.db, "stock_transfers", id(b.transferId));
      await gateTransfer(
        c.db,
        row,
        ["approve", "cancel"].includes(action)
          ? "inventory.approve"
          : "inventory.write",
        c.actor,
      );
      return row;
    },
    run: async (c, b, row) => {
      const rows =
        await c.db`select * from stock_transfer_lines where transfer_id=${row.id} order by id`;
      if (action === "approve") {
        state(row, ["requested"]);
        notSelf(c.actor, row.requested_by);
        await c.db`update stock_transfer_lines set approved_base=requested_base where transfer_id=${row.id}`;
        await c.db`update stock_transfers set status='approved',approved_by=${c.actor.userId} where id=${row.id}`;
        return { id: row.id };
      }
      if (action === "cancel") {
        state(row, ["requested", "approved"]);
        await c.db`update stock_transfers set status='cancelled' where id=${row.id}`;
        return { id: row.id };
      }
      state(row, action === "ship" ? ["approved"] : ["shipped"]);
      /** @type {MovementLine[]} */ const postingLines = [];
      if (action === "ship")
        for (const l of rows)
          postingLines.push({
            productId: l.product_id,
            quantityBase: Number(l.approved_base),
            uom: "base",
            fromLocationId: row.source_location_id,
            toLocationId: row.in_transit_location_id,
            fromStockStatus: "available",
            toStockStatus: "in_transit",
          });
      else {
        const outbound =
          await c.db`select * from inventory_movement_lines where movement_id=${row.outbound_movement_id} order by line_number`;
        for (const l of outbound) {
          const allocations =
            await c.db`select * from inventory_allocations where movement_line_id=${l.id} order by allocation_sequence`;
          for (const a of allocations.length
            ? allocations
            : [{ lot_id: null, quantity_base: l.quantity_base }])
            postingLines.push({
              productId: l.product_id,
              quantityBase: Number(a.quantity_base),
              lotId: a.lot_id,
              uom: "base",
              fromLocationId: row.in_transit_location_id,
              toLocationId: row.destination_location_id,
              fromStockStatus: "in_transit",
              toStockStatus: "available",
              unitCostMinor: Number(l.unit_cost_minor ?? 0),
            });
        }
      }
      const movement = await post(
        c,
        b,
        action === "ship" ? "transfer_ship" : "transfer_receive",
        "stock_transfer",
        row.id,
        postingLines,
      );
      if (action === "ship") {
        await c.db`update stock_transfer_lines set shipped_base=approved_base where transfer_id=${row.id}`;
        await c.db`update stock_transfers set status='shipped',shipped_by=${c.actor.userId},outbound_movement_id=${movement.movementId} where id=${row.id}`;
      } else {
        await c.db`update stock_transfer_lines set received_base=shipped_base where transfer_id=${row.id}`;
        await c.db`update stock_transfers set status='received',received_by=${c.actor.userId},receipt_movement_id=${movement.movementId} where id=${row.id}`;
      }
      return { id: row.id, ...movement };
    },
  };

commands["adjustments/request"] = {
  cap: "inventory.adjustment.request",
  prepare: async (c, b) => {
    await gateLines(c, "inventory.adjustment.request", lines(b.lines));
    return null;
  },
  run: async (c, b) => {
    const adjustmentId = crypto.randomUUID(),
      reason = text(b.reasonCode, "Reason", 100);
    await c.db`insert into inventory_adjustments (id,organization_id,adjustment_number,adjustment_type,reason_code,status,requested_by,note) values (${adjustmentId},${ORGANIZATION},${`ADJ-${adjustmentId.slice(0, 8).toUpperCase()}`},${text(b.adjustmentType ?? "manual", "Adjustment type", 80)},${reason},'submitted',${c.actor.userId},${b.note ?? null})`;
    for (const l of b.lines) {
      const pp = await productPolicy(c.db, id(l.productId));
      if (pp.tracking === "lot" && !l.lotId)
        invalid("Select a lot for this adjustment");
      if (l.lotId) {
        id(l.lotId);
        const [lot] =
          await c.db`select id from inventory_lots where id=${l.lotId} and product_id=${l.productId} and organization_id=${ORGANIZATION}`;
        if (!lot) invalid("Lot does not match product");
      }
      const v = integer(l.varianceBase, "Variance", -Number.MAX_SAFE_INTEGER);
      if (v === 0) invalid("Variance cannot be zero");
      await c.db`insert into inventory_adjustment_lines (organization_id,adjustment_id,product_id,lot_id,location_id,stock_status,variance_base,unit_cost_minor,reason_code) values (${ORGANIZATION},${adjustmentId},${l.productId},${l.lotId ?? null},${l.locationId},${choice(l.stockStatus, STATUSES, "available")},${v},${l.unitCostMinor == null ? null : integer(l.unitCostMinor, "Cost")},${reason})`;
    }
    return { id: adjustmentId };
  },
};
commands["adjustments/decide"] = {
  cap: "inventory.approve",
  prepare: async (c, b) => {
    const row = await document(
      c.db,
      "inventory_adjustments",
      id(b.adjustmentId),
    );
    return { row, rows: await adjustmentGate(c, row, "inventory.approve") };
  },
  run: async (c, b, { row, rows }) => {
    state(row, ["submitted"]);
    notSelf(c.actor, row.requested_by);
    const decision = choice(b.decision, ["approved", "rejected"]);
    if (decision === "rejected") {
      await c.db`update inventory_adjustments set status='rejected',approved_by=${c.actor.userId} where id=${row.id}`;
      return { id: row.id };
    }
    await enforceInventoryAuthority(c, row, rows);
    const movement = await post(
      c,
      b,
      "inventory_adjustment",
      "inventory_adjustment",
      row.id,
      rows.map((/** @type {any} */ l) => varianceLine(l, l.location_id)),
    );
    await c.db`update inventory_adjustments set status='posted',approved_by=${c.actor.userId},movement_id=${movement.movementId} where id=${row.id}`;
    return { id: row.id, ...movement };
  },
};

commands["counts/start"] = {
  cap: "inventory.count.submit",
  prepare: async (c, b) =>
    locationGate(c, "inventory.count.submit", id(b.locationId)),
  run: async (c, b, loc) => {
    const sessionId = crypto.randomUUID();
    const selected =
      b.productIds === undefined
        ? null
        : [
            ...new Set(
              lines(b.productIds).map((/** @type {any} */ v) => id(v)),
            ),
          ];
    if (selected && b.countType !== "cycle")
      invalid("A product subset is only allowed for a cycle count");
    const selectedJson = selected ? JSON.stringify(selected) : null;
    const rows =
      await c.db`select * from inventory_balances where organization_id=${ORGANIZATION} and location_id=${loc.id} and (${selectedJson}::text::jsonb is null or product_id::text in (select jsonb_array_elements_text(${selectedJson}::text::jsonb))) order by product_id for update`;
    /** @type {any[]} */ const snapshot = [];
    for (const row of rows) {
      const pp = await productPolicy(c.db, row.product_id);
      if (pp.tracking === "lot") {
        const lots =
          await c.db`select * from inventory_lot_balances where organization_id=${ORGANIZATION} and location_id=${loc.id} and product_id=${row.product_id} order by lot_id,stock_status for update`;
        for (const l of lots)
          snapshot.push({
            productId: row.product_id,
            lotId: l.lot_id,
            status: l.stock_status,
            system: l.physical_base,
            version: l.version,
            movement: l.last_movement_id,
          });
      } else
        for (const status of STATUSES) {
          const field = STATUS_FIELDS[status];
          if (status === "available" || Number(row[field ?? ""] ?? 0) !== 0)
            snapshot.push({
              productId: row.product_id,
              lotId: null,
              status,
              system: row[field ?? ""] ?? 0,
              version: row.version,
              movement: row.last_movement_id,
            });
        }
    }
    if (!snapshot.length) invalid("Receive stock before starting a count");
    if (snapshot.length > 100)
      invalid(
        "This location exceeds 100 count lines; split the location before counting",
        "session_too_large",
      );
    await c.db`insert into stock_count_sessions (id,organization_id,count_number,count_type,location_id,status,blind_count,snapshot_at,created_by,cycle_product_ids) values (${sessionId},${ORGANIZATION},${`SC-${sessionId.slice(0, 8).toUpperCase()}`},${choice(b.countType, ["cycle", "full", "spot", "route_close"], "cycle")},${loc.id},'counting',${b.blindCount !== false},${new Date(c.now)},${c.actor.userId},${selectedJson}::text::jsonb)`;
    for (const l of snapshot)
      await c.db`insert into stock_count_lines (organization_id,session_id,product_id,lot_id,stock_status,system_base,snapshot_balance_version,snapshot_movement_id) values (${ORGANIZATION},${sessionId},${l.productId},${l.lotId},${l.status},${l.system},${l.version},${l.movement})`;
    return { id: sessionId };
  },
};
/** @param {any} t @param {any} session @param {any[]} rows */
export async function freshSnapshot(t, session, rows) {
  const subset = session.cycle_product_ids
    ? JSON.stringify(session.cycle_product_ids)
    : null;
  const liveProducts =
    await t`select product_id from inventory_balances where organization_id=${ORGANIZATION} and location_id=${session.location_id} and (${subset}::text::jsonb is null or product_id::text in (select jsonb_array_elements_text(${subset}::text::jsonb)))`;
  const frozenProducts = new Set(rows.map((l) => l.product_id));
  if (
    liveProducts.length !== frozenProducts.size ||
    liveProducts.some(
      (/** @type {any} */ l) => !frozenProducts.has(l.product_id),
    )
  )
    throw new ApiError(
      "stale_snapshot",
      409,
      "The product roster changed. Start a new count.",
    );
  const lotRows =
    await t`select product_id,lot_id,stock_status from inventory_lot_balances where organization_id=${ORGANIZATION} and location_id=${session.location_id} and (${subset}::text::jsonb is null or product_id::text in (select jsonb_array_elements_text(${subset}::text::jsonb)))`;
  const frozenLots = new Set(
    rows
      .filter((l) => l.lot_id)
      .map((l) => `${l.product_id}:${l.lot_id}:${l.stock_status}`),
  );
  if (
    lotRows.length !== frozenLots.size ||
    lotRows.some(
      (/** @type {any} */ l) =>
        !frozenLots.has(`${l.product_id}:${l.lot_id}:${l.stock_status}`),
    )
  )
    throw new ApiError(
      "stale_snapshot",
      409,
      "The lot roster changed. Start a new count.",
    );
  for (const l of rows) {
    const [live] = l.lot_id
      ? await t`select * from inventory_lot_balances where organization_id=${ORGANIZATION} and lot_id=${l.lot_id} and location_id=${session.location_id} and stock_status=${l.stock_status} for update`
      : await t`select * from inventory_balances where organization_id=${ORGANIZATION} and product_id=${l.product_id} and location_id=${session.location_id} for update`;
    const qty =
      live?.[
        l.lot_id ? "physical_base" : (STATUS_FIELDS[l.stock_status] ?? "")
      ] ?? 0;
    if (
      Number(qty) !== Number(l.system_base) ||
      live?.version !== l.snapshot_balance_version ||
      (live?.last_movement_id ?? null) !== (l.snapshot_movement_id ?? null)
    )
      throw new ApiError(
        "stale_snapshot",
        409,
        "Stock changed since this count began. Start a new count.",
      );
  }
}
for (const action of ["submit", "approve", "cancel"])
  commands[`counts/${action}`] = {
    cap:
      action === "approve"
        ? "inventory.count.approve"
        : "inventory.count.submit",
    prepare: async (c, b) => {
      const row = await document(c.db, "stock_count_sessions", id(b.sessionId));
      await locationGate(
        c,
        action === "approve"
          ? "inventory.count.approve"
          : "inventory.count.submit",
        row.location_id,
      );
      return row;
    },
    run: async (c, b, row) => {
      if (action === "cancel") {
        state(row, ["counting", "submitted"]);
        await c.db`update stock_count_sessions set status='cancelled' where id=${row.id}`;
        return { id: row.id };
      }
      state(row, action === "submit" ? ["counting"] : ["submitted"]);
      const rows =
        await c.db`select * from stock_count_lines where session_id=${row.id} order by id`;
      await freshSnapshot(c.db, row, rows);
      if (action === "submit") {
        if (row.blind_count && row.created_by !== c.actor.userId)
          throw new ApiError(
            "forbidden",
            403,
            "Only the assigned counter may enter this blind count",
          );
        const entries = lines(b.lines);
        if (
          entries.length !== rows.length ||
          new Set(entries.map((l) => l.lineId)).size !== rows.length ||
          rows.some(
            (/** @type {any} */ r) => !entries.some((l) => l.lineId === r.id),
          )
        )
          invalid("Count every line exactly once");
        for (const l of entries) {
          integer(l.countedBase, "Count");
          await c.db`update stock_count_lines set counted_base=${l.countedBase},variance_base=${l.countedBase}-system_base,counted_by=${c.actor.userId},counted_at=${new Date(c.now)} where id=${l.lineId} and session_id=${row.id}`;
        }
        await c.db`update stock_count_sessions set status='submitted' where id=${row.id}`;
        return { id: row.id };
      }
      notSelf(c.actor, row.created_by);
      for (const l of rows) {
        notSelf(c.actor, l.counted_by);
        if (l.counted_base == null) invalid("Every line must be counted");
      }
      const adjustmentId = crypto.randomUUID(),
        reason = text(b.reasonCode ?? "stock_count", "Reason", 100);
      await c.db`insert into inventory_adjustments (id,organization_id,adjustment_number,adjustment_type,reason_code,source_count_id,status,requested_by,approved_by) values (${adjustmentId},${ORGANIZATION},${`ADJ-${adjustmentId.slice(0, 8).toUpperCase()}`},'stock_count',${reason},${row.id},'approved',${row.created_by},${c.actor.userId})`;
      const variance = rows.filter(
        (/** @type {any} */ l) => Number(l.variance_base) !== 0,
      );
      await enforceInventoryAuthority(
        c,
        {
          ...row,
          id: adjustmentId,
          source_count_id: row.id,
          reason_code: reason,
          adjustment_number: `ADJ-${adjustmentId.slice(0, 8).toUpperCase()}`,
        },
        variance,
        "inventory.count.submit",
      );
      for (const l of variance)
        await c.db`insert into inventory_adjustment_lines (organization_id,adjustment_id,product_id,lot_id,location_id,stock_status,variance_base,reason_code) values (${ORGANIZATION},${adjustmentId},${l.product_id},${l.lot_id},${row.location_id},${l.stock_status},${l.variance_base},${reason})`;
      const movement = variance.length
        ? await post(
            c,
            b,
            "inventory_adjustment",
            "stock_count",
            adjustmentId,
            variance.map((/** @type {any} */ l) =>
              varianceLine(l, row.location_id),
            ),
          )
        : null;
      await c.db`update inventory_adjustments set status='posted',movement_id=${movement?.movementId ?? null} where id=${adjustmentId}`;
      await c.db`update stock_count_sessions set status='posted',approved_by=${c.actor.userId},adjustment_id=${adjustmentId} where id=${row.id}`;
      return {
        id: row.id,
        adjustmentId,
        movementId: movement?.movementId ?? null,
      };
    },
  };

commands["reservations/create"] = {
  cap: "inventory.write",
  prepare: async (c, b) => {
    await lineGates(c, b);
    return null;
  },
  run: async (c, b) => {
    const reservationId = crypto.randomUUID();
    if (b.expiresAt != null && integer(b.expiresAt, "Expiry", 1) <= c.now)
      invalid("Reservation expiry must be in the future");
    await c.db`insert into inventory_reservations (id,organization_id,reservation_number,reservation_type,source_type,source_document_id,status,expires_at,created_by) values (${reservationId},${ORGANIZATION},${`RS-${reservationId.slice(0, 8).toUpperCase()}`},${text(b.reservationType ?? "order", "Reservation type", 80)},${text(b.sourceType ?? "order", "Source type", 80)},${text(b.sourceDocumentId, "Source reference", 200)},'active',${b.expiresAt ? new Date(b.expiresAt) : null},${c.actor.userId})`;
    const movement = await post(
      c,
      b,
      "reservation",
      "reservation",
      reservationId,
      b.lines.map((/** @type {any} */ l) => ({
        productId: id(l.productId),
        quantityBase: integer(l.quantityBase, "Quantity", 1),
        fromLocationId: l.locationId,
        toLocationId: null,
        uom: "base",
        lotId: l.lotId ?? null,
      })),
    );
    const ml =
      await c.db`select * from inventory_movement_lines where movement_id=${movement.movementId} order by line_number`;
    for (const l of ml) {
      const allocations =
        await c.db`select * from inventory_allocations where movement_line_id=${l.id}`;
      for (const a of allocations.length
        ? allocations
        : [{ lot_id: null, quantity_base: l.quantity_base }])
        await c.db`insert into inventory_reservation_lines (organization_id,reservation_id,product_id,location_id,lot_id,requested_base,reserved_base,consumed_base,released_base) values (${ORGANIZATION},${reservationId},${l.product_id},${l.from_location_id},${a.lot_id},${a.quantity_base},${a.quantity_base},0,0)`;
    }
    return { id: reservationId, ...movement };
  },
};
for (const action of ["release", "consume"])
  commands[`reservations/${action}`] = {
    cap: "inventory.write",
    prepare: async (c, b) => {
      const row = await document(
        c.db,
        "inventory_reservations",
        id(b.reservationId),
      );
      const rows =
        await c.db`select * from inventory_reservation_lines where reservation_id=${row.id} order by id`;
      await gateLines(c, "inventory.write", rows);
      return { row, rows };
    },
    run: async (c, b, { row, rows }) => {
      state(row, ["active", "partially_consumed"]);
      if (
        action === "consume" &&
        row.expires_at &&
        new Date(row.expires_at).getTime() <= c.now
      )
        invalid("This reservation has expired");
      const movement = await post(
        c,
        b,
        action === "release" ? "reservation_release" : "inventory_issue",
        "reservation",
        row.id,
        rows
          .filter(
            (/** @type {any} */ l) =>
              Number(l.reserved_base) >
              Number(l.consumed_base) + Number(l.released_base),
          )
          .map((/** @type {any} */ l) => ({
            productId: l.product_id,
            quantityBase:
              Number(l.reserved_base) -
              Number(l.consumed_base) -
              Number(l.released_base),
            fromLocationId: l.location_id,
            toLocationId: null,
            uom: "base",
            lotId: l.lot_id,
            ...(action === "consume"
              ? {
                  reservedDeltaBase: -(
                    Number(l.reserved_base) -
                    Number(l.consumed_base) -
                    Number(l.released_base)
                  ),
                }
              : {}),
          })),
      );
      if (action === "release")
        await c.db`update inventory_reservation_lines set released_base=reserved_base-consumed_base where reservation_id=${row.id}`;
      else
        await c.db`update inventory_reservation_lines set consumed_base=reserved_base-released_base where reservation_id=${row.id}`;
      await c.db`update inventory_reservations set status=${action === "release" ? "released" : "consumed"} where id=${row.id}`;
      return { id: row.id, ...movement };
    },
  };

commands["quality/change"] = {
  cap: "inventory.read",
  prepare: async (c, b) =>
    locationGate(
      c,
      b.toStatus === "available" ? "inventory.approve" : "inventory.write",
      id(b.locationId),
    ),
  run: async (c, b, loc) => {
    const [lot] =
      await c.db`select * from inventory_lots where id=${id(b.lotId)} and organization_id=${ORGANIZATION} for update`;
    if (!lot) invalid("Lot not found");
    if (
      b.toStatus === "available" &&
      lot.expires_at &&
      new Date(lot.expires_at).getTime() <= c.now
    )
      invalid("Expired stock cannot be released");
    text(b.reasonCode, "Reason", 100);
    const movement = await post(
      c,
      b,
      "status_change",
      "quality_control",
      lot.id,
      [
        {
          productId: lot.product_id,
          quantityBase: integer(b.quantityBase, "Quantity", 1),
          uom: "base",
          fromLocationId: loc.id,
          toLocationId: loc.id,
          fromStockStatus: choice(b.fromStatus, STATUSES),
          toStockStatus: choice(b.toStatus, STATUSES),
          lotId: lot.id,
        },
      ],
    );
    const quality =
      b.toStatus === "available"
        ? "released"
        : b.toStatus === "expired"
          ? "expired"
          : b.toStatus === "rejected"
            ? "rejected"
            : "quarantined";
    await c.db`update inventory_lots set quality_status=${quality} where id=${lot.id}`;
    return { id: lot.id, ...movement };
  },
};

commands["replenishment/save"] = {
  cap: "inventory.write",
  prepare: async (c, b) => {
    if (b.locationId)
      return locationGate(c, "inventory.write", id(b.locationId));
    await requireNationalScope(c, ["admin"]);
    return null;
  },
  run: async (c, b) => {
    await productPolicy(c.db, id(b.productId));
    integer(b.reorderPointBase, "Reorder point");
    integer(b.targetLevelBase, "Target stock", 1);
    integer(b.safetyStockBase ?? 0, "Safety stock");
    if (b.targetLevelBase <= b.reorderPointBase)
      invalid("Target stock must exceed the reorder point");
    const [r] =
      await c.db`insert into replenishment_policies (organization_id,product_id,location_id,enabled,reorder_point_base,target_level_base,safety_stock_base,lead_time_days,alert_cooldown_ms) values (${ORGANIZATION},${b.productId},${b.locationId ?? null},${b.enabled !== false},${b.reorderPointBase},${b.targetLevelBase},${b.safetyStockBase ?? 0},${b.leadTimeDays == null ? null : integer(b.leadTimeDays, "Lead time")},${integer(b.alertCooldownMs ?? 86400000, "Alert cooldown")}) on conflict (organization_id,product_id,location_id) do update set enabled=excluded.enabled,reorder_point_base=excluded.reorder_point_base,target_level_base=excluded.target_level_base,safety_stock_base=excluded.safety_stock_base,lead_time_days=excluded.lead_time_days,alert_cooldown_ms=excluded.alert_cooldown_ms returning id`;
    return { id: r.id };
  },
};
commands["negative/allow"] = {
  cap: "admin.manage",
  prepare: async (c, b) => {
    await requireNationalScope(c, ["admin"]);
    return locationGate(c, "inventory.write", id(b.locationId));
  },
  run: async (c, b, loc) => {
    if (
      !["warehouse", "zone", "bin", "truck"].includes(loc.type) ||
      !loc.active
    )
      invalid(
        "Below-zero stock is only allowed at active distributor stock locations",
      );
    if (typeof b.active !== "boolean")
      invalid("Set whether this allowance is active");
    const types = [
      ...new Set(
        (b.movementTypes ?? []).map((/** @type {any} */ v) =>
          choice(v, ["pos_sale", "inventory_issue", "transfer_ship"]),
        ),
      ),
    ];
    if (b.active && !types.length) invalid("Choose at least one movement type");
    const [r] =
      await c.db`insert into negative_stock_allowances (organization_id,location_id,operation,movement_types,limit_base,active,source_ref,version,updated_by) values (${ORGANIZATION},${loc.id},'distributor',${`{${types.join(",")}}`}::text[],${b.limitBase == null ? null : integer(b.limitBase, "Limit", 1)},${b.active},${text(b.sourceRef, "Source reference", 200)},1,${c.actor.userId}) on conflict (organization_id,location_id) do update set movement_types=excluded.movement_types,limit_base=excluded.limit_base,active=excluded.active,source_ref=excluded.source_ref,version=negative_stock_allowances.version+1,updated_by=excluded.updated_by returning id`;
    await recordChange(c.db, {
      entity: "negative_stock_allowances",
      entityId: r.id,
      scopeKey: loc.org_unit_id ?? "unscoped",
      op: "upsert",
    });
    return { id: r.id };
  },
};
commands["negative/resolve"] = {
  cap: "inventory.adjustment.approve",
  prepare: async (c, b) => {
    const row = await document(c.db, "negative_stock_flags", id(b.flagId));
    await locationGate(c, "inventory.adjustment.approve", row.location_id);
    return row;
  },
  run: async (c, b, row) => {
    state(row, ["open"]);
    notSelf(c.actor, row.posted_by);
    const note = text(b.note, "Settlement note", 500);
    const [balance] =
      await c.db`select * from inventory_balances where organization_id=${ORGANIZATION} and product_id=${row.product_id} and location_id=${row.location_id} for update`;
    if (
      Number(balance?.available_base ?? 0) < 0 ||
      Number(balance?.physical_base ?? 0) < 0
    )
      invalid(
        "Stock is still below zero; receive or count it before resolving",
      );
    await c.db`update negative_stock_flags set status='resolved',resolved_by=${c.actor.userId},resolved_at=${new Date(c.now)},resolution_note=${note} where id=${row.id}`;
    return { id: row.id };
  },
};
