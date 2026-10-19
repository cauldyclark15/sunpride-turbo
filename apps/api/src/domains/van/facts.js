import { uuid, refuse, integer, safeNumber } from "./model.js";

/** @param {any} db @param {string} id @param {number} [at] */
export async function productFor(db, id, at = Date.now()) {
  uuid(id);
  const [p] =
    await db`select p.*, coalesce(ip.quantity_scale,p.quantity_scale,1) as scale, coalesce(u.code,p.uom) as base_code,
    coalesce(ip.base_uom_id,p.base_uom_id) as base_id
    from products p left join product_inventory_policies ip on ip.product_id=p.id and ip.active and ip.deleted_at is null
    left join units_of_measure u on u.id=coalesce(ip.base_uom_id,p.base_uom_id)
    where p.id=${id} and p.active and p.deleted_at is null`;
  if (!p) refuse("Product is unavailable", "invalid_request");
  const conversions =
    await db`select u.code,c.numerator,c.denominator from uom_conversions c join units_of_measure u on u.id=c.from_uom_id
    where (c.product_id=${id} or c.product_id is null) and c.to_uom_id=${p.base_id}
    and c.active and c.deleted_at is null and c.effective_from<=${new Date(at)} and (c.effective_to is null or c.effective_to>${new Date(at)})
    order by c.product_id nulls last`;
  const factors = new Map([[String(p.base_code), BigInt(p.scale)]]);
  for (const c of conversions) {
    if (factors.has(c.code)) continue;
    const n = BigInt(c.numerator) * BigInt(p.scale),
      d = BigInt(c.denominator);
    if (d <= 0n || n % d !== 0n)
      refuse("Unit conversion needs setup", "invalid_request");
    factors.set(c.code, n / d);
  }
  const caseBase =
    factors.get("CS") ??
    factors.get("CASE") ??
    factors.get("CASES") ??
    (p.base_code === "CS" ? BigInt(p.scale) : 0n);
  const pieceBase =
    factors.get("PC") ??
    factors.get("PCS") ??
    factors.get("PIECE") ??
    (p.base_code === "EA" ? BigInt(p.scale) : 0n);
  return { ...p, factors, caseBase, pieceBase, quantityScale: BigInt(p.scale) };
}
/** @param {any} p */
export const frozenProduct = (p) => ({
  productId: p.id,
  code: p.code,
  name: p.name,
  uomCode: p.base_code,
  quantityScale: String(p.scale),
  caseBase: String(p.caseBase),
  pieceBase: String(p.pieceBase),
});
/** @param {any} db @param {any} trip @param {string} sourceId @param {string} kind @param {any[]} lines */
export async function explainStock(db, trip, sourceId, kind, lines) {
  for (const l of lines) {
    const facts = l.facts ?? frozenProduct(await productFor(db, l.productId));
    await db`insert into van_stock_events(trip_id,source_id,kind,product_id,stock_status,delta_base,facts)
      values(${trip.id},${sourceId},${kind},${l.productId},${l.status ?? "available"},${String(l.delta)},${facts})`;
  }
}
/** Expected truck stock from complete trip facts, not independently maintained balances. @param {any} db @param {string} tripId */
export async function expectedStock(db, tripId) {
  const events =
    await db`select * from van_stock_events where trip_id=${tripId} order by created_at,id`;
  /** @type {Map<string,any>} */ const result = new Map();
  for (const e of events) {
    const key = `${e.product_id}:${e.stock_status}`;
    const old = result.get(key) ?? {
      productId: e.product_id,
      status: e.stock_status,
      expectedBase: 0n,
      facts: e.facts,
    };
    old.expectedBase += BigInt(e.delta_base);
    result.set(key, old);
  }
  // The handheld counts both sellable and damaged stock for every product, including zero rows.
  for (const e of [...result.values()]) {
    const other = e.status === "available" ? "damaged" : "available",
      key = `${e.productId}:${other}`;
    if (!result.has(key))
      result.set(key, {
        productId: e.productId,
        status: other,
        expectedBase: 0n,
        facts: e.facts,
      });
  }
  return [...result.values()].sort(
    (a, b) =>
      a.productId.localeCompare(b.productId) ||
      a.status.localeCompare(b.status),
  );
}
/** Refuse unexplained canonical stock changes instead of adjusting against a stale trip projection. @param {any} db @param {any} trip @param {any[]} expected */
export async function assertTruckStock(db, trip, expected) {
  const actual =
    await db`select product_id,physical_base,available_base,damaged_base from inventory_balances where location_id=${trip.truck_location_id} and deleted_at is null`;
  const ids = new Set([
    ...expected.map((e) => e.productId),
    ...actual.map((/** @type {any} */ a) => a.product_id),
  ]);
  for (const id of ids) {
    const rows = actual.filter((/** @type {any} */ a) => a.product_id === id);
    if (rows.length > 1)
      refuse("Truck balance has duplicate products", "stock_conflict");
    const a = rows[0],
      available = BigInt(a?.available_base ?? 0),
      damaged = BigInt(a?.damaged_base ?? 0),
      physical = BigInt(a?.physical_base ?? 0);
    const wantAvailable =
      expected.find((e) => e.productId === id && e.status === "available")
        ?.expectedBase ?? 0n;
    const wantDamaged =
      expected.find((e) => e.productId === id && e.status === "damaged")
        ?.expectedBase ?? 0n;
    if (
      available !== wantAvailable ||
      damaged !== wantDamaged ||
      physical !== available + damaged
    )
      refuse(
        "Canonical truck stock changed; refresh and reconcile before counting or closing",
        "stock_conflict",
      );
  }
}
/** @param {any} db @param {string} tripId */
export async function cashExpectation(db, tripId) {
  const [r] =
    await db`select coalesce(sum(case when kind in ('refund','void_refund') then -amount_centavos else amount_centavos end),0)::text as expected
    from van_payments where trip_id=${tripId} and method='cash'`;
  return BigInt(r.expected);
}
/** @param {any} db @param {string} tripId */
export async function assertNotCounted(db, tripId) {
  const [r] =
    await db`select (exists(select 1 from van_cash_counts where trip_id=${tripId}) or exists(select 1 from van_stock_counts where trip_id=${tripId})) as locked`;
  if (r.locked)
    refuse("The trip is counted; selling and stock changes are locked");
}
/** @param {any} db @param {any} trip @param {any} actor @param {string} kind @param {string} entityId @param {any} [details] */
export async function audit(db, trip, actor, kind, entityId, details = {}) {
  await db`insert into van_audit_events(trip_id,actor_profile_id,actor_name,kind,entity_id,details)
    values(${trip?.id ?? null},${actor.profileId},${actor.name ?? "Former user"},${kind},${entityId},${details})`;
}
/** @param {any} db @param {any} trip @param {any} p @param {string} kind @param {string|null} saleId @param {string|null} [returnId] */
export async function payment(db, trip, p, kind, saleId, returnId = null) {
  const id = p.paymentId ? uuid(p.paymentId) : crypto.randomUUID();
  const amount = integer(p.amountMinor);
  await db`insert into van_payments(id,trip_id,sale_id,return_id,kind,method,amount_centavos,facts)
    values(${id},${trip.id},${saleId},${returnId},${kind},${p.method},${String(amount)},${p})`;
  safeNumber(amount);
  return id;
}
