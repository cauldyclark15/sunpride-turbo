import { ApiError } from "../../core/errors.js";
import { actorFor } from "../../core/context.js";
import { recordChange } from "../../core/sync.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import {
  audit,
  choice,
  id,
  integer,
  invalid,
  lines,
  locationGate,
  productPolicy,
  STATUSES,
  STATUS_FIELDS,
  stockLock,
  text,
} from "./common.js";

/**
 * @typedef {{productId:string, fromLocationId:string|null, toLocationId:string|null, quantityBase:number, uom:string,
 * lotId?:string|null, stockStatus?:string, fromStockStatus?:string, toStockStatus?:string,
 * unitCostMinor?:number, reservedDeltaBase?:number}} MovementLine
 * @typedef {{kind:string, sourceType:string, sourceId:string, idempotencyKey:string, occurredAt:number,
 * actor:{profileId:string|null,userId:string|null}, organizationId:string, lines:MovementLine[], note?:string, authorizedLocations?:string[]}} MovementInput
 */
const KINDS = [
  "opening_balance",
  "goods_receipt",
  "inventory_issue",
  "reservation",
  "reservation_release",
  "transfer_ship",
  "transfer_receive",
  "inventory_adjustment",
  "status_change",
  "pos_sale",
  "pos_void",
  "pos_return",
  "reversal",
  "van_load",
  "van_unload",
];
const NEGATIVE_KINDS = ["pos_sale", "inventory_issue", "transfer_ship"];

/**
 * The ONLY stock/ledger writer. The caller supplies an open transaction; never pass a pool.
 * Role-specific command permission belongs to the calling domain (e.g. van.operate); this
 * seam rechecks the current actor and EVERY persisted location's scope before replay.
 * Internal optional line fields add status changes, reservation deltas and receipt cost
 * without changing the binding cross-lane shape. Null actor is trusted scheduled work only.
 * @param {any} tx @param {MovementInput} input
 * @returns {Promise<{movementId:string, duplicate:boolean}>}
 */
export async function postMovement(tx, input) {
  const org = text(input.organizationId, "Organization", 100);
  const key = text(input.idempotencyKey, "Idempotency key", 512);
  choice(input.kind, KINDS);
  text(input.sourceType, "Source type", 100);
  text(input.sourceId, "Source reference", 200);
  integer(input.occurredAt, "Movement time", 1);
  lines(input.lines);
  await stockLock(tx, org);
  let actor = null;
  if (input.actor.userId) {
    actor = await actorFor(tx, input.actor.userId);
    if (!actor || actor.profileId !== input.actor.profileId)
      throw new ApiError(
        "forbidden",
        403,
        "Inventory actor is no longer active",
      );
  } else if (input.actor.profileId || input.sourceType !== "expiry_job")
    throw new ApiError(
      "forbidden",
      403,
      "A stock movement needs an active person",
    );
  const locationIds = [
    ...new Set(
      input.lines
        .flatMap((l) => [l.fromLocationId, l.toLocationId])
        .filter(Boolean),
    ),
  ];
  // A calling domain may vouch for locations it authorized itself (a van trip's depot and truck
  // were scope-checked when the trip was planned; the seller then moves stock only between them).
  // Only those exact ids skip the actor's per-location scope gate; every other line stays gated.
  /** @type {Set<string>} */ const vouched = new Set();
  if (input.authorizedLocations !== undefined) {
    if (
      !Array.isArray(input.authorizedLocations) ||
      input.authorizedLocations.length > 4
    )
      invalid("Invalid authorized locations");
    for (const l of input.authorizedLocations) vouched.add(id(l, "Location"));
  }
  const locations = new Map();
  for (const locationId of locationIds) {
    id(locationId, "Location");
    const [loc] =
      await tx`select * from inventory_locations where id=${locationId} and organization_id=${org} and deleted_at is null for share`;
    if (!loc) invalid("Movement location not found");
    if (actor && !vouched.has(loc.id))
      await locationGate({ db: tx, actor }, "inventory.read", loc.id, org);
    if (!loc.active) invalid("Movement location is inactive");
    locations.set(loc.id, loc);
  }
  const hash = sha256Hex(canonicalJson(input));
  const [prior] =
    await tx`select * from inventory_commands where organization_id=${org} and idempotency_key=${key}`;
  if (prior) {
    if (
      prior.payload_hash !== hash ||
      prior.actor_subject !== (actor?.userId ?? "system:expiry")
    )
      throw new ApiError(
        "idempotency_conflict",
        409,
        "This key was used for different stock work",
      );
    return { movementId: prior.movement_id, duplicate: true };
  }
  const now = new Date();
  const at = new Date(input.occurredAt);
  const movementId = crypto.randomUUID();
  await tx`insert into inventory_movements (id,organization_id,movement_number,movement_type,source_type,source_document_id,status,effective_at,posted_at,posted_by,idempotency_key,note,schema_version)
    values (${movementId},${org},${`MV-${movementId.slice(0, 8).toUpperCase()}`},${input.kind},${input.sourceType},${input.sourceId},'posted',${at},${now},${actor?.userId ?? "system:expiry"},${key},${input.note ?? null},2)`;
  const changed = new Map();
  for (const [index, line] of input.lines.entries()) {
    integer(line.quantityBase, "Quantity", 1);
    text(line.uom, "Unit", 40);
    if (!line.fromLocationId && !line.toLocationId)
      invalid("A stock line needs a source or destination");
    const fromStatus = choice(
      line.fromStockStatus ?? line.stockStatus,
      STATUSES,
      "available",
    );
    const toStatus = choice(
      line.toStockStatus ?? line.stockStatus,
      STATUSES,
      "available",
    );
    const reservation = ["reservation", "reservation_release"].includes(
      input.kind,
    );
    if (
      reservation &&
      (!line.fromLocationId || line.toLocationId || fromStatus !== "available")
    )
      invalid("Reservations require a source of available stock");
    if (
      !reservation &&
      line.fromLocationId === line.toLocationId &&
      fromStatus === toStatus
    )
      invalid("Source and destination are identical");
    if (line.unitCostMinor != null) integer(line.unitCostMinor, "Cost");
    const { product, policy, tracking, scale } = await productPolicy(
      tx,
      line.productId,
      org,
    );
    if (tracking === "serial")
      invalid("Serial stock is not enabled for this release");
    const [source] = line.fromLocationId
      ? await tx`select * from inventory_balances where organization_id=${org} and product_id=${line.productId} and location_id=${line.fromLocationId} for update`
      : [];
    const unitCost = BigInt(
      line.unitCostMinor ?? source?.weighted_average_cost_minor ?? 0,
    );
    const [ml] =
      await tx`insert into inventory_movement_lines (organization_id,movement_id,line_number,product_id,base_uom_id,quantity_base,entered_uom_code,from_location_id,to_location_id,from_stock_status,to_stock_status,unit_cost_minor,total_cost_minor,effective_at)
      values (${org},${movementId},${index + 1},${product.id},${policy?.base_uom_id ?? product.base_uom_id},${line.quantityBase},${line.uom},${line.fromLocationId},${line.toLocationId},${line.fromLocationId ? fromStatus : null},${line.toLocationId ? toStatus : null},${unitCost.toString()},${((unitCost * BigInt(line.quantityBase)) / BigInt(scale)).toString()},${at}) returning id`;
    const parts = await allocate(
      tx,
      org,
      line,
      policy,
      tracking,
      fromStatus,
      input.kind,
      input.occurredAt,
    );
    for (const [ordinal, part] of parts.entries()) {
      let allocationId = null;
      if (part.lotId) {
        const [a] =
          await tx`insert into inventory_allocations (organization_id,movement_id,movement_line_id,product_id,lot_id,quantity_base,from_location_id,to_location_id,from_stock_status,to_stock_status,allocation_sequence,allocation_policy,user_selected,effective_at)
          values (${org},${movementId},${ml.id},${product.id},${part.lotId},${part.quantity},${line.fromLocationId},${line.toLocationId},${line.fromLocationId ? fromStatus : null},${line.toLocationId ? toStatus : null},${ordinal + 1},${policy?.allocation_policy ?? product.allocation_policy ?? "fifo"},${Boolean(line.lotId)},${at}) returning id`;
        allocationId = a.id;
      }
      for (const side of ["from", "to"]) {
        const locationId =
          side === "from" ? line.fromLocationId : line.toLocationId;
        if (!locationId) continue;
        const status = side === "from" ? fromStatus : toStatus;
        const quantity = BigInt(part.quantity);
        const delta = reservation ? 0n : side === "from" ? -quantity : quantity;
        let reserved = reservation
          ? input.kind === "reservation"
            ? quantity
            : -quantity
          : 0n;
        if (line.reservedDeltaBase != null) {
          if (
            side !== "from" ||
            line.reservedDeltaBase !== -line.quantityBase ||
            input.kind !== "inventory_issue"
          )
            invalid("Invalid reservation consumption");
          reserved = -quantity;
        }
        const loc = locations.get(locationId);
        let allowance = null;
        if (
          side === "from" &&
          !reservation &&
          tracking === "none" &&
          !line.lotId &&
          fromStatus === "available" &&
          line.fromLocationId !== line.toLocationId &&
          reserved === 0n &&
          NEGATIVE_KINDS.includes(input.kind) &&
          ["warehouse", "zone", "bin", "truck"].includes(loc.type)
        ) {
          const [a] =
            await tx`select * from negative_stock_allowances where organization_id=${org} and location_id=${locationId} and active and deleted_at is null for share`;
          if (a?.movement_types.includes(input.kind)) allowance = a;
        }
        const summary = await applyDelta(tx, {
          org,
          product,
          loc,
          status,
          delta,
          physicalDelta: line.fromLocationId === line.toLocationId ? 0n : delta,
          reserved,
          unitCost,
          scale,
          movementId,
          allowance,
        });
        if (part.lotId)
          await applyLot(tx, {
            org,
            productId: product.id,
            lotId: part.lotId,
            locationId,
            status,
            delta,
            reserved,
            movementId,
          });
        await tx`insert into inventory_ledger_entries (organization_id,movement_id,movement_line_id,allocation_id,product_id,lot_id,location_id,stock_status,quantity_delta_base,reserved_delta_base,value_delta_minor,balance_version,quantity_before_base,quantity_after_base,effective_at,posted_at)
          values (${org},${movementId},${ml.id},${allocationId},${product.id},${part.lotId},${locationId},${status},${delta.toString()},${reserved.toString()},${summary.valueDelta.toString()},${summary.version},${summary.before.toString()},${summary.after.toString()},${at},${now})`;
        changed.set(summary.id, loc.org_unit_id);
        if (allowance && summary.available < 0n) {
          await tx`insert into negative_stock_flags (organization_id,allowance_id,movement_id,movement_type,product_id,location_id,quantity_base,balance_after_base,shortfall_base,status,posted_by)
            values (${org},${allowance.id},${movementId},${input.kind},${product.id},${locationId},${quantity.toString()},${summary.available.toString()},${(quantity < -summary.available ? quantity : -summary.available).toString()},'open',${actor?.userId})`;
        }
      }
    }
  }
  await tx`insert into inventory_commands (organization_id,idempotency_key,command_type,schema_version,payload_hash,actor_subject,status,source_document_id,movement_id,result,committed_at)
    values (${org},${key},${input.kind},2,${hash},${actor?.userId ?? "system:expiry"},'posted',${input.sourceId},${movementId},${{ movementId }},${now})`;
  await audit(tx, actor, `${input.kind}.posted`, movementId, {
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  });
  await tx`insert into integration_events (event_id,direction,event_type,status,attempts,payload,received_at,organization_id,schema_version,payload_hash,source_document_id,movement_id,next_attempt_at)
    values (${`inventory-${movementId}`},'outbound',${`inventory.${input.kind}.posted`},'pending',0,${{ movementId, kind: input.kind, sourceType: input.sourceType, sourceId: input.sourceId }},${now},${org},2,${hash},${input.sourceId},${movementId},${now})`;
  for (const [entityId, unit] of changed)
    await recordChange(tx, {
      entity: "inventory_balances",
      entityId,
      scopeKey: unit ?? "unscoped",
      op: "upsert",
    });
  return { movementId, duplicate: false };
}

/** @param {any} t @param {string} org @param {MovementLine} line @param {any} policy @param {string} tracking @param {string} status @param {string} kind @param {number} at @returns {Promise<Array<{lotId:string|null,quantity:number}>>} */
async function allocate(t, org, line, policy, tracking, status, kind, at) {
  if (tracking === "none") {
    if (line.lotId) invalid("Untracked stock cannot use a lot");
    return [{ lotId: null, quantity: line.quantityBase }];
  }
  const policyName = policy?.allocation_policy ?? "fefo";
  const sale =
    [
      "inventory_issue",
      "pos_sale",
      "transfer_ship",
      "van_load",
      "reservation",
    ].includes(kind) && status === "available";
  const cutoff = new Date(
    Math.max(at, Date.now()) +
      Number(policy?.minimum_remaining_shelf_life_days ?? 0) * 86400000,
  );
  if (line.lotId) {
    id(line.lotId, "Lot");
    const [lot] =
      await t`select * from inventory_lots where id=${line.lotId} and organization_id=${org} and product_id=${line.productId} for update`;
    if (!lot) invalid("Lot does not belong to this product");
    if (
      sale &&
      (lot.quality_status !== "released" ||
        (lot.expires_at && new Date(lot.expires_at) <= cutoff) ||
        (Number(policy?.minimum_remaining_shelf_life_days) > 0 &&
          !lot.expires_at))
    )
      invalid(
        "This lot is expired, held, or too close to expiry",
        "ineligible_lot",
      );
    return [{ lotId: lot.id, quantity: line.quantityBase }];
  }
  if (!line.fromLocationId || policyName === "explicit_only")
    invalid("Select a lot for this movement");
  const candidates =
    await t`select b.*,l.expires_at,l.quality_status from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id
    where b.organization_id=${org} and b.product_id=${line.productId} and b.location_id=${line.fromLocationId} and b.stock_status=${status}
      and b.available_base>0 order by b.expiry_sort_key,b.receipt_sequence,b.id for update of b,l`;
  if (policyName === "fifo")
    candidates.sort(
      (/** @type {any} */ a, /** @type {any} */ b) =>
        Number(a.receipt_sequence) - Number(b.receipt_sequence),
    );
  let left = line.quantityBase;
  const result = [];
  for (const row of candidates) {
    if (
      sale &&
      (row.quality_status !== "released" ||
        (row.expires_at && new Date(row.expires_at) <= cutoff) ||
        (Number(policy?.minimum_remaining_shelf_life_days) > 0 &&
          !row.expires_at))
    )
      continue;
    const qty = Math.min(left, Number(row.available_base));
    result.push({ lotId: row.lot_id, quantity: qty });
    left -= qty;
    if (!left) break;
    if (result.length >= 50)
      invalid(
        "This movement needs more than 50 lots; split the document",
        "allocation_overflow",
      );
  }
  if (left) invalid("Insufficient eligible lot stock", "negative_stock");
  if (policy?.allow_mixed_lots_per_line === false && result.length > 1)
    invalid("Mixed lots are not allowed on this product");
  return result;
}

/** @param {any} t @param {any} a */
async function applyDelta(t, a) {
  const { org, product, loc, status, scale, movementId, allowance } = a;
  const delta = BigInt(a.delta),
    reserved = BigInt(a.reserved),
    unitCost = BigInt(a.unitCost);
  const field = /** @type {string} */ (STATUS_FIELDS[status]);
  await t`insert into inventory_balances (product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,available_stock_base,reserved_base,available_base,quality_hold_base,quarantine_base,damaged_base,expired_base,rejected_base,wip_base,in_transit_base,weighted_average_cost_minor,inventory_value_minor,version)
    values (${product.code},${loc.code},0,0,0,now(),${org},${product.id},${loc.id},0,0,0,0,0,0,0,0,0,0,0,0,0,0)
    on conflict (organization_id,product_id,location_id) where product_id is not null and location_id is not null do nothing`;
  const [row] =
    await t`select * from inventory_balances where organization_id=${org} and product_id=${product.id} and location_id=${loc.id} for update`;
  const physicalDelta = BigInt(a.physicalDelta);
  const before = BigInt(row[field] ?? 0),
    after = before + delta,
    physical = BigInt(row.physical_base) + physicalDelta;
  const reservedAfter = BigInt(row.reserved_base) + reserved;
  const available =
    (status === "available" ? after : BigInt(row.available_stock_base)) -
    reservedAfter;
  const previousAvailable = BigInt(row.available_base),
    previousPhysical = BigInt(row.physical_base);
  if (
    reservedAfter < 0n ||
    (!allowance &&
      ((after < 0n && after < before) ||
        (physical < 0n && physical < previousPhysical) ||
        (available < 0n && available < previousAvailable)))
  )
    invalid("Insufficient available stock", "negative_stock");
  if (
    allowance?.limit_base != null &&
    (available < -BigInt(allowance.limit_base) ||
      physical < -BigInt(allowance.limit_base))
  )
    invalid(
      "The below-zero allowance limit would be exceeded",
      "negative_stock_limit",
    );
  const valueBefore = BigInt(row.inventory_value_minor ?? 0);
  let valueAfter = valueBefore + (unitCost * physicalDelta) / BigInt(scale);
  if (previousPhysical < 0n && physicalDelta > 0n)
    valueAfter =
      physical <= 0n
        ? (valueBefore * physical) / previousPhysical
        : (unitCost * physical) / BigInt(scale);
  // A complete depletion carries the final rounding centavo, so value reconciles exactly.
  if (physical === 0n) valueAfter = 0n;
  if (!allowance && valueAfter < 0n && valueAfter < valueBefore)
    invalid(
      "The movement would make the inventory book value negative",
      "negative_stock_value",
    );
  const version = Number(row.version ?? 0) + 1;
  const average =
    physical === 0n
      ? 0n
      : physical < 0n
        ? BigInt(row.weighted_average_cost_minor ?? unitCost)
        : (valueAfter * BigInt(scale)) / physical;
  await t.unsafe(
    `update inventory_balances set ${field}=$1, physical_base=$2,reserved_base=$3,available_base=$4,on_hand=$5,reserved=$6,available=$7,weighted_average_cost_minor=$8,inventory_value_minor=$9,version=$10,last_movement_id=$11,as_of=now() where id=$12`,
    [
      after.toString(),
      physical.toString(),
      reservedAfter.toString(),
      available.toString(),
      Number(physical) / scale,
      Number(reservedAfter) / scale,
      Number(available) / scale,
      average.toString(),
      valueAfter.toString(),
      version,
      movementId,
      row.id,
    ],
  );
  return {
    id: row.id,
    before,
    after,
    version,
    valueDelta: valueAfter - valueBefore,
    available,
  };
}

/** @param {any} t @param {any} a */
async function applyLot(t, a) {
  const {
    org,
    productId,
    lotId,
    locationId,
    status,
    delta,
    reserved,
    movementId,
  } = a;
  const [lot] = await t`select * from inventory_lots where id=${lotId}`;
  await t`insert into inventory_lot_balances (organization_id,product_id,lot_id,location_id,stock_status,physical_base,reserved_base,available_base,expiry_sort_key,receipt_sequence,version)
    values (${org},${productId},${lotId},${locationId},${status},0,0,0,${lot.expires_at ? new Date(lot.expires_at).getTime() : Number.MAX_SAFE_INTEGER},${new Date(lot.received_at).getTime()},0)
    on conflict (organization_id,lot_id,location_id,stock_status) do nothing`;
  const [row] =
    await t`select * from inventory_lot_balances where organization_id=${org} and lot_id=${lotId} and location_id=${locationId} and stock_status=${status} for update`;
  const physical = BigInt(row.physical_base) + delta,
    held = BigInt(row.reserved_base) + reserved;
  if (physical < 0n || held < 0n || physical - held < 0n)
    invalid("Insufficient unreserved lot stock", "negative_stock");
  await t`update inventory_lot_balances set physical_base=${physical.toString()},reserved_base=${held.toString()},available_base=${(physical - held).toString()},version=version+1,last_movement_id=${movementId} where id=${row.id}`;
}
