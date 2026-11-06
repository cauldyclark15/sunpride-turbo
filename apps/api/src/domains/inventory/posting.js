import { enqueueMovementPosting } from "../integration/posting.js";
import { ApiError } from "../../core/errors.js";
import { actorFor } from "../../core/context.js";
import { recordChange } from "../../core/sync.js";
import { canonicalJson, isUuid, sha256Hex } from "../../core/util.js";
import {
  audit,
  choice,
  id,
  integer,
  invalid,
  lines,
  locationGate,
  postingLocks,
  productCatalog,
  STATUSES,
  STATUS_FIELDS,
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
  // IP-VALUE: per-(product, location) locks taken in one sorted order (deadlock-free), plus a
  // shared hold on the org lock so whole-org holders (stockLock) still exclude postings.
  await postingLocks(tx, org, key, input.lines);
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
  for (const locationId of locationIds) id(locationId, "Location");
  const locationRows = locationIds.length
    ? await tx`select * from inventory_locations where id in ${tx(locationIds)} and organization_id=${org} and deleted_at is null order by id for share`
    : [];
  const locationById = new Map(
    locationRows.map((/** @type {any} */ r) => [r.id, r]),
  );
  for (const locationId of locationIds) {
    const loc = locationById.get(locationId);
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

  // ---- set-based preloads: catalog, lots, holds, allowances, balances (a handful of queries,
  // not a handful per line). Everything below runs under the locks taken above.
  const catalog = await productCatalog(
    tx,
    input.lines.map((l) => l.productId),
    org,
  );
  const explicitLots = [
    ...new Set(
      input.lines.map((l) => l.lotId).filter((v) => v && isUuid(v)),
    ),
  ].sort();
  /** @type {Map<string,any>} */ const lotById = new Map();
  /** @type {Set<string>} */ const heldLots = new Set();
  if (explicitLots.length) {
    for (const r of await tx`select * from inventory_lots where id in ${tx(explicitLots)} and organization_id=${org} order by id for share`)
      lotById.set(r.id, r);
    for (const r of await tx`select distinct lot_id from inventory_lot_holds where lot_id in ${tx(explicitLots)} and released_at is null`)
      heldLots.add(r.lot_id);
  }
  const fromLocationIds = [
    ...new Set(input.lines.map((l) => l.fromLocationId).filter(Boolean)),
  ];
  /** @type {Map<string,any>} */ const allowances = new Map();
  if (fromLocationIds.length)
    for (const a of await tx`select * from negative_stock_allowances where organization_id=${org} and location_id in ${tx(fromLocationIds)} and active and deleted_at is null order by id for share`)
      if (!allowances.has(a.location_id)) allowances.set(a.location_id, a);
  /** @type {Map<string,{product_id:string,location_id:string,product_code:string,warehouse_code:string}>} */
  const pairs = new Map();
  for (const l of input.lines)
    for (const loc of [l.fromLocationId, l.toLocationId]) {
      const product = loc && catalog.peek(l.productId);
      if (product)
        pairs.set(`${product.id}:${loc}`, {
          product_id: product.id,
          location_id: loc,
          product_code: product.code,
          warehouse_code: locations.get(loc).code,
        });
    }
  /** @type {Map<string,any>} */ const balances = new Map();
  if (pairs.size) {
    const wanted = JSON.stringify([...pairs.values()]);
    await tx`insert into inventory_balances (product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,available_stock_base,reserved_base,available_base,quality_hold_base,quarantine_base,damaged_base,expired_base,rejected_base,wip_base,in_transit_base,weighted_average_cost_minor,inventory_value_minor,version)
      select r.product_code,r.warehouse_code,0,0,0,now(),${org},r.product_id,r.location_id,0,0,0,0,0,0,0,0,0,0,0,0,0,0
      from jsonb_to_recordset(${wanted}::text::jsonb) as r(product_code text,warehouse_code text,product_id uuid,location_id uuid)
      on conflict (organization_id,product_id,location_id) where product_id is not null and location_id is not null do nothing`;
    const rows =
      await tx`select b.* from inventory_balances b join jsonb_to_recordset(${wanted}::text::jsonb) as k(product_id uuid,location_id uuid) on b.product_id=k.product_id and b.location_id=k.location_id where b.organization_id=${org} order by b.id for update of b`;
    for (const r of rows)
      balances.set(`${r.product_id}:${r.location_id}`, balanceState(r));
  }

  const changed = new Map();
  /** @type {any[]} */ const lineRows = [];
  /** @type {any[]} */ const allocationRows = [];
  /** @type {any[]} */ const ledgerRows = [];
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
    let toStatus = choice(
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
    const { product, policy, tracking, scale } = catalog.get(line.productId);
    if (line.lotId && line.toLocationId && toStatus === "available") {
      if (heldLots.has(line.lotId)) {
        if (["pos_void", "pos_return", "reversal"].includes(input.kind))
          toStatus = "quality_hold";
        else
          invalid(
            "This batch is under recall; receive or transfer it into held stock",
            "recall_hold",
          );
      }
    }
    if (tracking === "serial")
      invalid("Serial stock is not enabled for this release");
    const source = line.fromLocationId
      ? balances.get(`${product.id}:${line.fromLocationId}`)
      : undefined;
    const unitCost = BigInt(
      line.unitCostMinor ?? source?.weightedAverageCost ?? 0,
    );
    lineRows.push({
      line_number: index + 1,
      product_id: product.id,
      base_uom_id: policy?.base_uom_id ?? product.base_uom_id,
      quantity_base: String(line.quantityBase),
      entered_uom_code: line.uom,
      from_location_id: line.fromLocationId ?? null,
      to_location_id: line.toLocationId ?? null,
      from_stock_status: line.fromLocationId ? fromStatus : null,
      to_stock_status: line.toLocationId ? toStatus : null,
      unit_cost_minor: unitCost.toString(),
      total_cost_minor: (
        (unitCost * BigInt(line.quantityBase)) /
        BigInt(scale)
      ).toString(),
    });
    const parts = await allocate(
      tx,
      org,
      line,
      policy,
      tracking,
      fromStatus,
      input.kind,
      input.occurredAt,
      lotById,
      heldLots,
    );
    for (const [ordinal, part] of parts.entries()) {
      if (part.lotId)
        allocationRows.push({
          li: index,
          lot_id: part.lotId,
          product_id: product.id,
          quantity_base: String(part.quantity),
          from_location_id: line.fromLocationId ?? null,
          to_location_id: line.toLocationId ?? null,
          from_stock_status: line.fromLocationId ? fromStatus : null,
          to_stock_status: line.toLocationId ? toStatus : null,
          allocation_sequence: ordinal + 1,
          allocation_policy:
            policy?.allocation_policy ?? product.allocation_policy ?? "fifo",
          user_selected: Boolean(line.lotId),
        });
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
          const a = allowances.get(locationId);
          if (a?.movement_types.includes(input.kind)) allowance = a;
        }
        const summary = applyDelta(
          /** @type {any} */ (balances.get(`${product.id}:${locationId}`)),
          {
            status,
            delta,
            physicalDelta: line.fromLocationId === line.toLocationId ? 0n : delta,
            reserved,
            unitCost,
            scale,
            allowance,
          },
        );
        if (part.lotId)
          await applyLot(tx, {
            org,
            productId: product.id,
            lotId: part.lotId,
            sortKey: part.expirySortKey,
            receiptSequence: part.receiptSequence,
            locationId,
            status,
            delta,
            reserved,
            movementId,
          });
        ledgerRows.push({
          li: index,
          allocationSequence: part.lotId ? ordinal + 1 : null,
          product_id: product.id,
          lot_id: part.lotId,
          location_id: locationId,
          stock_status: status,
          quantity_delta_base: delta.toString(),
          reserved_delta_base: reserved.toString(),
          value_delta_minor: summary.valueDelta.toString(),
          balance_version: summary.version,
          quantity_before_base: summary.before.toString(),
          quantity_after_base: summary.after.toString(),
        });
        changed.set(summary.id, loc.org_unit_id);
        if (allowance && summary.available < 0n) {
          const shortfall =
            quantity < -summary.available ? quantity : -summary.available;
          await tx`insert into negative_stock_flags (organization_id,allowance_id,movement_id,movement_type,product_id,location_id,quantity_base,balance_after_base,shortfall_base,status,posted_by)
            values (${org},${allowance.id},${movementId},${input.kind},${product.id},${locationId},${quantity.toString()},${summary.available.toString()},${shortfall.toString()},'open',${actor?.userId})`;
        }
      }
    }
  }
  // ---- set-based writes: lines, allocations, ledger, balances (4 statements for any line count).
  const lineIds = new Map();
  for (const r of await tx`insert into inventory_movement_lines (organization_id,movement_id,line_number,product_id,base_uom_id,quantity_base,entered_uom_code,from_location_id,to_location_id,from_stock_status,to_stock_status,unit_cost_minor,total_cost_minor,effective_at)
    select ${org},${movementId},r.line_number,r.product_id,r.base_uom_id,r.quantity_base,r.entered_uom_code,r.from_location_id,r.to_location_id,r.from_stock_status,r.to_stock_status,r.unit_cost_minor,r.total_cost_minor,${at}
    from jsonb_to_recordset(${JSON.stringify(lineRows)}::text::jsonb) as r(line_number int,product_id uuid,base_uom_id uuid,quantity_base bigint,entered_uom_code text,from_location_id uuid,to_location_id uuid,from_stock_status text,to_stock_status text,unit_cost_minor bigint,total_cost_minor bigint)
    returning id,line_number`)
    lineIds.set(r.line_number, r.id);
  const allocationIds = new Map();
  if (allocationRows.length) {
    const payload = allocationRows.map((r) => ({
      ...r,
      movement_line_id: lineIds.get(r.li + 1),
    }));
    for (const r of await tx`insert into inventory_allocations (organization_id,movement_id,movement_line_id,product_id,lot_id,quantity_base,from_location_id,to_location_id,from_stock_status,to_stock_status,allocation_sequence,allocation_policy,user_selected,effective_at)
      select ${org},${movementId},r.movement_line_id,r.product_id,r.lot_id,r.quantity_base,r.from_location_id,r.to_location_id,r.from_stock_status,r.to_stock_status,r.allocation_sequence,r.allocation_policy,r.user_selected,${at}
      from jsonb_to_recordset(${JSON.stringify(payload)}::text::jsonb) as r(movement_line_id uuid,product_id uuid,lot_id uuid,quantity_base bigint,from_location_id uuid,to_location_id uuid,from_stock_status text,to_stock_status text,allocation_sequence int,allocation_policy text,user_selected boolean)
      returning id,movement_line_id,allocation_sequence`)
      allocationIds.set(`${r.movement_line_id}:${r.allocation_sequence}`, r.id);
  }
  const ledgerPayload = ledgerRows.map((r) => {
    const lineId = lineIds.get(r.li + 1);
    return {
      ...r,
      movement_line_id: lineId,
      allocation_id:
        r.allocationSequence == null
          ? null
          : allocationIds.get(`${lineId}:${r.allocationSequence}`),
    };
  });
  await tx`insert into inventory_ledger_entries (organization_id,movement_id,movement_line_id,allocation_id,product_id,lot_id,location_id,stock_status,quantity_delta_base,reserved_delta_base,value_delta_minor,balance_version,quantity_before_base,quantity_after_base,effective_at,posted_at)
    select ${org},${movementId},r.movement_line_id,r.allocation_id,r.product_id,r.lot_id,r.location_id,r.stock_status,r.quantity_delta_base,r.reserved_delta_base,r.value_delta_minor,r.balance_version,r.quantity_before_base,r.quantity_after_base,${at},${now}
    from jsonb_to_recordset(${JSON.stringify(ledgerPayload)}::text::jsonb) as r(movement_line_id uuid,allocation_id uuid,product_id uuid,lot_id uuid,location_id uuid,stock_status text,quantity_delta_base bigint,reserved_delta_base bigint,value_delta_minor bigint,balance_version int,quantity_before_base bigint,quantity_after_base bigint)`;
  const dirty = [...balances.values()].filter((b) => b.dirty);
  if (dirty.length)
    await tx`update inventory_balances b set available_stock_base=v.available_stock_base,quality_hold_base=v.quality_hold_base,quarantine_base=v.quarantine_base,damaged_base=v.damaged_base,expired_base=v.expired_base,rejected_base=v.rejected_base,wip_base=v.wip_base,in_transit_base=v.in_transit_base,
      physical_base=v.physical_base,reserved_base=v.reserved_base,available_base=v.available_base,on_hand=v.on_hand,reserved=v.reserved,available=v.available,weighted_average_cost_minor=v.wac,inventory_value_minor=v.val,version=v.version,last_movement_id=${movementId},as_of=now()
      from jsonb_to_recordset(${JSON.stringify(dirty.map((b) => balanceRow(b)))}::text::jsonb) as v(id uuid,available_stock_base bigint,quality_hold_base bigint,quarantine_base bigint,damaged_base bigint,expired_base bigint,rejected_base bigint,wip_base bigint,in_transit_base bigint,physical_base bigint,reserved_base bigint,available_base bigint,on_hand numeric,reserved numeric,available numeric,wac bigint,val bigint,version int)
      where b.id=v.id`;
  await tx`insert into inventory_commands (organization_id,idempotency_key,command_type,schema_version,payload_hash,actor_subject,status,source_document_id,movement_id,result,committed_at)
    values (${org},${key},${input.kind},2,${hash},${actor?.userId ?? "system:expiry"},'posted',${input.sourceId},${movementId},${{ movementId }},${now})`;
  await audit(tx, actor, `${input.kind}.posted`, movementId, {
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  });
  // F-119 replace the retired transport event with the single SAP outbox effect.
  await enqueueMovementPosting(tx, movementId);
  // Last on purpose: recordChange holds a global change-log lock until commit.
  // The first call takes the lock (and writes its row); the rest go in as one statement.
  const [firstChange, ...moreChanges] = [...changed];
  if (firstChange)
    await recordChange(tx, {
      entity: "inventory_balances",
      entityId: firstChange[0],
      scopeKey: firstChange[1] ?? "unscoped",
      op: "upsert",
    });
  if (moreChanges.length)
    await tx`insert into change_log (entity, entity_id, scope_key, op)
      select 'inventory_balances',c.entity_id,c.scope_key,'upsert' from jsonb_to_recordset(${JSON.stringify(moreChanges.map(([entityId, unit]) => ({ entity_id: entityId, scope_key: unit ?? "unscoped" })))}::text::jsonb) as c(entity_id text,scope_key text)`;
  return { movementId, duplicate: false };
}

const STATUS_COLUMNS = Object.values(STATUS_FIELDS);
/** In-memory copy of one locked balance row; every line of the movement applies to it in order.
 * @param {any} row */
function balanceState(row) {
  /** @type {Record<string,bigint>} */ const fields = {};
  for (const f of STATUS_COLUMNS) fields[f] = BigInt(row[f] ?? 0);
  return {
    id: row.id,
    fields,
    physical: BigInt(row.physical_base ?? 0),
    reserved: BigInt(row.reserved_base ?? 0),
    available: BigInt(row.available_base ?? 0),
    availableStock: BigInt(row.available_stock_base ?? 0),
    value: BigInt(row.inventory_value_minor ?? 0),
    weightedAverageCost:
      row.weighted_average_cost_minor == null
        ? null
        : BigInt(row.weighted_average_cost_minor),
    version: Number(row.version ?? 0),
    scale: 1,
    dirty: false,
  };
}
/** @param {ReturnType<typeof balanceState>} b */
function balanceRow(b) {
  const scale = b.scale;
  return {
    id: b.id,
    ...Object.fromEntries(
      Object.entries(b.fields).map(([k, v]) => [k, v.toString()]),
    ),
    physical_base: b.physical.toString(),
    reserved_base: b.reserved.toString(),
    available_base: b.available.toString(),
    on_hand: Number(b.physical) / scale,
    reserved: Number(b.reserved) / scale,
    available: Number(b.available) / scale,
    wac: (b.weightedAverageCost ?? 0n).toString(),
    val: b.value.toString(),
    version: b.version,
  };
}

/** The pure part of the old applyDelta, on the in-memory balance.
 * @param {ReturnType<typeof balanceState>} row @param {any} a */
function applyDelta(row, a) {
  const { status, scale, allowance } = a;
  const delta = BigInt(a.delta),
    reserved = BigInt(a.reserved),
    unitCost = BigInt(a.unitCost);
  const field = /** @type {string} */ (STATUS_FIELDS[status]);
  row.scale = scale;
  const physicalDelta = BigInt(a.physicalDelta);
  const before = row.fields[field],
    after = before + delta,
    physical = row.physical + physicalDelta;
  const reservedAfter = row.reserved + reserved;
  const available =
    (status === "available" ? after : row.availableStock) - reservedAfter;
  const previousAvailable = row.available,
    previousPhysical = row.physical;
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
  const valueBefore = row.value;
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
  const version = row.version + 1;
  const average =
    physical === 0n
      ? 0n
      : physical < 0n
        ? (row.weightedAverageCost ?? unitCost)
        : (valueAfter * BigInt(scale)) / physical;
  row.fields[field] = after;
  if (status === "available") row.availableStock = after;
  row.physical = physical;
  row.reserved = reservedAfter;
  row.available = available;
  row.weightedAverageCost = average;
  row.value = valueAfter;
  row.version = version;
  row.dirty = true;
  return {
    id: row.id,
    before,
    after,
    version,
    valueDelta: valueAfter - valueBefore,
    available,
  };
}

/** One upsert per lot allocation part instead of four statements.
 * @param {any} t @param {any} a */
async function applyLot(t, a) {
  const {
    org,
    productId,
    lotId,
    sortKey,
    receiptSequence,
    locationId,
    status,
    delta,
    reserved,
    movementId,
  } = a;
  const [row] = await t`insert into inventory_lot_balances as lb (organization_id,product_id,lot_id,location_id,stock_status,physical_base,reserved_base,available_base,expiry_sort_key,receipt_sequence,version,last_movement_id)
    values (${org},${productId},${lotId},${locationId},${status},${delta.toString()},${reserved.toString()},${(delta - reserved).toString()},${String(sortKey)},${String(receiptSequence)},1,${movementId})
    on conflict (organization_id,lot_id,location_id,stock_status) do update set physical_base=lb.physical_base+${delta.toString()}::bigint,reserved_base=lb.reserved_base+${reserved.toString()}::bigint,available_base=lb.physical_base+${delta.toString()}::bigint-(lb.reserved_base+${reserved.toString()}::bigint),version=lb.version+1,last_movement_id=${movementId}
    returning physical_base,reserved_base,available_base`;
  if (
    BigInt(row.physical_base) < 0n ||
    BigInt(row.reserved_base) < 0n ||
    BigInt(row.available_base) < 0n
  )
    invalid("Insufficient unreserved lot stock", "negative_stock");
}

/** @param {any} t @param {string} org @param {MovementLine} line @param {any} policy @param {string} tracking @param {string} status @param {string} kind @param {number} at @param {Map<string,any>} lotById @param {Set<string>} heldLots @returns {Promise<Array<{lotId:string|null,quantity:number,expirySortKey?:number|string,receiptSequence?:number|string}>>} */
async function allocate(
  t,
  org,
  line,
  policy,
  tracking,
  status,
  kind,
  at,
  lotById,
  heldLots,
) {
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
    const row = lotById.get(line.lotId);
    const lot =
      row && row.product_id === line.productId
        ? { ...row, recall_held: heldLots.has(row.id) }
        : null;
    if (!lot) invalid("Lot does not belong to this product");
    if (
      sale &&
      (lot.recall_held ||
        lot.quality_status !== "released" ||
        (lot.expires_at && new Date(lot.expires_at) <= cutoff) ||
        (Number(policy?.minimum_remaining_shelf_life_days) > 0 &&
          !lot.expires_at))
    )
      invalid(
        "This lot is expired, held, or too close to expiry",
        "ineligible_lot",
      );
    return [
      {
        lotId: lot.id,
        quantity: line.quantityBase,
        expirySortKey: lot.expires_at
          ? new Date(lot.expires_at).getTime()
          : Number.MAX_SAFE_INTEGER,
        receiptSequence: new Date(lot.received_at).getTime(),
      },
    ];
  }
  if (!line.fromLocationId || policyName === "explicit_only")
    invalid("Select a lot for this movement");
  const candidates =
    await t`select b.*,l.expires_at,l.quality_status,exists(select 1 from inventory_lot_holds h where h.lot_id=l.id and h.released_at is null) as recall_held from inventory_lot_balances b join inventory_lots l on l.id=b.lot_id
    where b.organization_id=${org} and b.product_id=${line.productId} and b.location_id=${line.fromLocationId} and b.stock_status=${status}
      and b.available_base>0 order by b.expiry_sort_key,b.receipt_sequence,b.id for update of b for share of l`;
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
      (row.recall_held ||
        row.quality_status !== "released" ||
        (row.expires_at && new Date(row.expires_at) <= cutoff) ||
        (Number(policy?.minimum_remaining_shelf_life_days) > 0 &&
          !row.expires_at))
    )
      continue;
    const qty = Math.min(left, Number(row.available_base));
    result.push({
      lotId: row.lot_id,
      quantity: qty,
      expirySortKey: row.expiry_sort_key,
      receiptSequence: row.receipt_sequence,
    });
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
