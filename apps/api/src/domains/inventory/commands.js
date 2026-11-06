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

// Stock counts v2 live in counts.js (plan, save per line, review per line, approve one adjustment).
import { installCountCommands } from "./counts.js";
installCountCommands();

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

// IP-XFER: transfer and goods-receipt commands live in transfers.js and receiving.js and register here,
// so every importer of this registry (store POS, extensions) sees them without an install step.
import { installTransferCommands } from "./transfers.js";
import { installReceivingCommands } from "./receiving.js";
installTransferCommands();
installReceivingCommands();
