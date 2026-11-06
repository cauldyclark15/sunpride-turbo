import { ApiError } from "../../core/errors.js";
import { requireCapability } from "../../core/capabilities.js";
import {
  blindStockGate,
  choice,
  id,
  integer,
  invalid,
  locationGate,
  manilaDate,
  number,
  ORGANIZATION,
  snapshot,
  visibleLocations,
} from "./common.js";
import { presenter } from "./units.js";

/**
 * Stock on hand + stock card (SPEC 4.6). Cost value is the weighted average the ledger already
 * keeps in inventory_balances; selling value is the default price list. Both come from the SAME rows,
 * so "Stock on hand cost value = sum of the stock card closing values" holds by construction
 * (ledger value deltas add up to the balance value).
 */

const STATUS_FILTERS = [
  "available",
  "reserved",
  "hold",
  "damaged",
  "expired",
  "in_transit",
];
const BUCKETS = /** @type {Record<string,(b:any)=>number>} */ ({
  available: (b) => number(b.available_base),
  reserved: (b) => number(b.reserved_base),
  hold: (b) => number(b.quality_hold_base) + number(b.quarantine_base),
  damaged: (b) => number(b.damaged_base) + number(b.rejected_base),
  expired: (b) => number(b.expired_base),
  in_transit: (b) => number(b.in_transit_base),
});

/** Whole pesos from integer centavos, no float: 125050 -> "1250.50". @param {number|null} centavos */
export function pesos(centavos) {
  if (centavos == null) return "";
  const abs = Math.abs(centavos);
  return `${centavos < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
/** Per-base-unit cost x quantity, rounded half up, in centavos.
 * @param {number} base @param {number|bigint|string|null} wac cost of one product unit (scale base units) @param {number} scale */
function costOf(base, wac, scale) {
  const w = BigInt(wac ?? 0),
    q = BigInt(Math.abs(base)),
    s = BigInt(scale);
  const v = Number((q * w * 2n + s) / (s * 2n));
  return base < 0 ? -v : v;
}
/** @param {any[]} rows @param {string} filename */
function csvResponse(rows, filename) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (/** @type {any} */ v) => {
    let t = v == null ? "" : String(v);
    if (typeof v !== "number" && /^[\s\u0000-\u001f]*[=+@-]/u.test(t))
      t = "'" + t;
    return '"' + t.replaceAll('"', '""') + '"';
  };
  return new Response(
    "\uFEFF" +
      [
        keys.map(cell).join(","),
        ...rows.map((r) => keys.map((k) => cell(r[k])).join(",")),
      ].join("\r\n") +
      "\r\n",
    {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    },
  );
}
/** @param {any[]} locations @param {string} rootId */
export function withDescendants(locations, rootId) {
  const out = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of locations)
      if (l.parent_location_id && out.has(l.parent_location_id) && !out.has(l.id)) {
        out.add(l.id);
        grew = true;
      }
  }
  return out;
}

/**
 * Stock on hand rows, one per product and location (or per batch with groupBy=lot).
 * @param {any} ctx @param {{basis?:string,locationId?:string|null,productId?:string|null,status?:string|null,
 * groupBy?:string,expiringWithinDays?:number|null,category?:string|null}} q
 */
export async function stockOnHand(ctx, q) {
  return snapshot(ctx.db, async (db) => {
    const c = { ...ctx, db };
    const basis = choice(q.basis, ["cost", "selling"], "cost");
    const groupBy = choice(q.groupBy, ["product", "lot"], "product");
    if (q.status) choice(q.status, STATUS_FILTERS);
    let locations = await visibleLocations(c);
    const tree = locations;
    if (q.locationId) {
      await locationGate(c, "inventory.read", id(q.locationId, "Location"));
      const ids = withDescendants(tree, q.locationId);
      locations = locations.filter((l) => ids.has(l.id));
    }
    const ids = locations.map((l) => l.id);
    await blindStockGate(c, ids);
    const asOf = ctx.now ?? Date.now();
    /** @type {any[]} */ let source = [];
    if (ids.length) {
      source =
        groupBy === "lot"
          ? await db`select lb.product_id,lb.location_id,lb.lot_id,l.lot_number,l.expires_at,
              sum(lb.physical_base) filter (where true) as physical_base,
              sum(lb.available_base) filter (where lb.stock_status='available') as available_base,
              sum(lb.reserved_base) as reserved_base,
              sum(lb.physical_base) filter (where lb.stock_status='quality_hold') + coalesce(sum(lb.physical_base) filter (where lb.stock_status='quarantine'),0) as hold_base,
              sum(lb.physical_base) filter (where lb.stock_status in ('damaged','rejected')) as damaged_base,
              sum(lb.physical_base) filter (where lb.stock_status='expired') as expired_base,
              sum(lb.physical_base) filter (where lb.stock_status='in_transit') as in_transit_base,
              max(b.weighted_average_cost_minor) as weighted_average_cost_minor,
              max(p.code) as code,max(p.name) as name,max(p.category) as category
            from inventory_lot_balances lb join inventory_lots l on l.id=lb.lot_id join products p on p.id=lb.product_id
              left join inventory_balances b on b.organization_id=lb.organization_id and b.product_id=lb.product_id and b.location_id=lb.location_id
            where lb.organization_id=${ORGANIZATION} and lb.location_id in ${db(ids)}
              and (${q.productId ?? null}::uuid is null or lb.product_id=${q.productId ?? null})
              and (${q.category ?? null}::text is null or p.category=${q.category ?? null})
              and (${q.expiringWithinDays ?? null}::int is null or (l.expires_at is not null and l.expires_at<=${new Date(asOf + (q.expiringWithinDays ?? 0) * 86400000)}))
            group by lb.product_id,lb.location_id,lb.lot_id,l.lot_number,l.expires_at
            having sum(lb.physical_base)<>0
            order by max(p.code),l.expires_at nulls last,l.lot_number`
          : await db`select b.*,p.code,p.name,p.category from inventory_balances b join products p on p.id=b.product_id
            where b.organization_id=${ORGANIZATION} and b.location_id in ${db(ids)} and (b.physical_base<>0 or b.reserved_base<>0)
              and (${q.productId ?? null}::uuid is null or b.product_id=${q.productId ?? null})
              and (${q.category ?? null}::text is null or p.category=${q.category ?? null})
            order by p.code,b.location_id`;
    }
    if (source.length > 5000)
      throw new ApiError(
        "scope_too_large",
        422,
        "Narrow the location or product filter to view stock",
      );
    /** @type {Map<string,any>} */ const presenters = new Map();
    for (const r of source)
      if (!presenters.has(r.product_id))
        presenters.set(r.product_id, await presenter(db, r.product_id, asOf));
    const locationById = new Map(locations.map((l) => [l.id, l]));
    /** @type {any[]} */ const rows = [];
    for (const r of source) {
      const p = presenters.get(r.product_id);
      const scale = p.units.scale;
      const bucketBase =
        groupBy === "lot"
          ? {
              available: number(r.available_base),
              reserved: number(r.reserved_base),
              hold: number(r.hold_base),
              damaged: number(r.damaged_base),
              expired: number(r.expired_base),
              in_transit: number(r.in_transit_base),
            }
          : Object.fromEntries(
              Object.entries(BUCKETS).map(([k, f]) => [k, f(r)]),
            );
      if (q.status && !bucketBase[q.status]) continue;
      const physical = number(r.physical_base);
      const loc = locationById.get(r.location_id);
      const qtyOf = (/** @type {number} */ base) => p.quantity(base);
      const physicalQ = qtyOf(physical);
      const costValue =
        groupBy === "lot"
          ? costOf(physical, r.weighted_average_cost_minor, scale)
          : number(r.inventory_value_minor);
      const days =
        r.expires_at == null
          ? null
          : Math.ceil((new Date(r.expires_at).getTime() - asOf) / 86400000);
      rows.push({
        productId: r.product_id,
        code: r.code,
        name: r.name,
        category: r.category,
        locationId: r.location_id,
        locationCode: loc?.code,
        locationName: loc?.name,
        ...(groupBy === "lot"
          ? {
              lotId: r.lot_id,
              lotNumber: r.lot_number,
              expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
              daysToExpiry: days,
            }
          : {}),
        onHand: physicalQ,
        available: qtyOf(bucketBase.available),
        reserved: qtyOf(bucketBase.reserved),
        hold: qtyOf(bucketBase.hold),
        damaged: qtyOf(bucketBase.damaged),
        expired: qtyOf(bucketBase.expired),
        inTransit: qtyOf(bucketBase.in_transit),
        averageCostCentavos:
          r.weighted_average_cost_minor == null
            ? null
            : number(r.weighted_average_cost_minor),
        costValueCentavos: costValue,
        costKnown: physical === 0 || costValue !== 0,
        sellingValueCentavos: physicalQ.valueCentavos,
        units: p.units,
      });
    }
    const sum = (/** @type {string} */ k) =>
      rows.some((r) => /** @type {any} */ (r)[k] == null)
        ? null
        : rows.reduce((s, r) => s + number(/** @type {any} */ (r)[k]), 0);
    return {
      asOf,
      basis,
      groupBy,
      valueLabel:
        basis === "cost"
          ? "Cost value (average cost of what we bought)"
          : "Selling value (default price list)",
      secondaryValueLabel:
        basis === "cost"
          ? "Selling value (default price list)"
          : "Cost value (average cost of what we bought)",
      rows,
      totals: {
        costValueCentavos: sum("costValueCentavos"),
        sellingValueCentavos: sum("sellingValueCentavos"),
        rowsWithoutCost: rows.filter((r) => !r.costKnown).length,
        rowsWithoutPrice: rows.filter((r) => r.sellingValueCentavos == null)
          .length,
      },
    };
  });
}

/** CSV with every money column in pesos (never centavos). @param {any} result */
export function stockCsv(result) {
  return csvResponse(
    result.rows.map((/** @type {any} */ r) => {
      const row = /** @type {Record<string, any>} */ ({
        Product: r.name,
        Code: r.code,
        Location: r.locationName,
      });
      if (r.lotNumber !== undefined) {
        row.Batch = r.lotNumber;
        row.Expires = r.expiresAt ? manilaDate(r.expiresAt) : "";
      }
      for (const [label, q] of /** @type {[string,any][]} */ ([
        ["On hand", r.onHand],
        ["Available", r.available],
        ["Reserved", r.reserved],
        ["On hold", r.hold],
        ["Damaged", r.damaged],
        ["Expired", r.expired],
        ["In transit", r.inTransit],
      ])) {
        row[`${label} cases`] = q.cases ?? "";
        row[`${label} pieces`] = q.pieces ?? q.base;
      }
      const cost = ["Cost value (PHP)", pesos(r.costValueCentavos)];
      const sell = ["Selling value (PHP)", pesos(r.sellingValueCentavos)];
      const ordered = result.basis === "cost" ? [cost, sell] : [sell, cost];
      for (const [k, v] of ordered) row[k] = v;
      return row;
    }),
    `stock-on-hand-${result.basis}.csv`,
  );
}

/** @param {any} ctx */
export async function valuation(ctx) {
  const p = ctx.url.searchParams;
  const result = await stockOnHand(ctx, {
    basis: p.get("basis") ?? "cost",
    locationId: p.get("locationId"),
    productId: p.get("productId") ? id(p.get("productId"), "Product") : null,
    status: p.get("status"),
    groupBy: p.get("groupBy") ?? "product",
    category: p.get("category"),
    expiringWithinDays:
      p.get("expiringWithinDays") == null
        ? null
        : integer(Number(p.get("expiringWithinDays")), "Days", 0),
  });
  if (p.get("format") === "csv") return stockCsv(result);
  return result;
}

/** @param {any} v @param {string} name */
function dateParam(v, name) {
  if (v == null || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))
    invalid(`${name} must be a date like 2026-11-06`);
  return /** @type {string} */ (v);
}
const DOCUMENT_TABLES = /** @type {Record<string,[string,string,string]>} */ ({
  goods_receipt: ["goods_receipts", "receipt_number", "Receipt"],
  stock_transfer: ["stock_transfers", "transfer_number", "Transfer"],
  inventory_adjustment: ["inventory_adjustments", "adjustment_number", "Adjustment"],
  stock_count: ["inventory_adjustments", "adjustment_number", "Count adjustment"],
  reservation: ["inventory_reservations", "reservation_number", "Reservation"],
  store_sale: ["store_sales", "receipt_number", "Store sale"],
  van_sale: ["van_sales", "receipt_number", "Van sale"],
  disposition: ["inventory_dispositions", "disposition_number", "Disposition"],
});
const KIND_LABELS = /** @type {Record<string,string>} */ ({
  opening_balance: "Opening stock",
  goods_receipt: "Received",
  inventory_issue: "Issued",
  reservation: "Reserved",
  reservation_release: "Reservation released",
  transfer_ship: "Sent out",
  transfer_receive: "Received from transfer",
  inventory_adjustment: "Adjustment",
  status_change: "Moved between statuses",
  pos_sale: "Sold",
  pos_void: "Sale voided",
  pos_return: "Customer return",
  reversal: "Reversed",
  van_load: "Loaded on van",
  van_unload: "Unloaded from van",
});

/**
 * Stock card: one product at one location, every movement with its document number, in, out,
 * running balance and value. `from`/`to` are Manila dates; opening is everything before `from`.
 * @param {any} ctx
 */
export async function stockCard(ctx) {
  return snapshot(ctx.db, async (db) => {
    const c = { ...ctx, db };
    await requireCapability(c, "inventory.read");
    const p = ctx.url.searchParams;
    const productId = id(p.get("productId"), "Product"),
      locationId = id(p.get("locationId"), "Location");
    const loc = await locationGate(c, "inventory.read", locationId);
    await blindStockGate(c, [locationId]);
    const today = manilaDate(ctx.now ?? Date.now());
    const to = dateParam(p.get("to"), "To") ?? today;
    const from =
      dateParam(p.get("from"), "From") ??
      manilaDate(Date.parse(`${to}T12:00:00+08:00`) - 30 * 86400000);
    if (from > to) invalid("The start date is after the end date");
    const limit = integer(Number(p.get("limit") ?? 500), "Page size", 1);
    if (limit > 5000)
      throw new ApiError("invalid_request", 400, "Page size cannot exceed 5000");
    const offset = integer(Number(p.get("cursor") ?? 0), "Page cursor", 0);
    const pres = await presenter(db, productId, ctx.now ?? Date.now());
    const start = new Date(`${from}T00:00:00+08:00`),
      end = new Date(`${to}T23:59:59.999+08:00`);
    const [opening] = await db`select coalesce(sum(quantity_delta_base),0)::bigint as q,coalesce(sum(value_delta_minor),0)::bigint as v
      from inventory_ledger_entries where organization_id=${ORGANIZATION} and product_id=${productId} and location_id=${locationId} and effective_at<${start}`;
    const [inRange] = await db`select coalesce(sum(quantity_delta_base),0)::bigint as q,coalesce(sum(value_delta_minor),0)::bigint as v,
        coalesce(sum(quantity_delta_base) filter (where quantity_delta_base>0),0)::bigint as pos,
        coalesce(sum(-quantity_delta_base) filter (where quantity_delta_base<0),0)::bigint as neg
      from inventory_ledger_entries where organization_id=${ORGANIZATION} and product_id=${productId} and location_id=${locationId} and effective_at>=${start} and effective_at<=${end}`;
    const grouped = await db`select e.movement_id,m.movement_number,m.movement_type,m.source_type,m.source_document_id,m.note,m.effective_at,m.status as movement_status,
        min(e.balance_version) as bv,sum(e.quantity_delta_base)::bigint as net,coalesce(sum(e.value_delta_minor),0)::bigint as vd,
        sum(abs(e.quantity_delta_base))::bigint as moved,
        jsonb_agg(jsonb_build_object('status',e.stock_status,'delta',e.quantity_delta_base::text) order by e.stock_status) as statuses
      from inventory_ledger_entries e join inventory_movements m on m.id=e.movement_id
      where e.organization_id=${ORGANIZATION} and e.product_id=${productId} and e.location_id=${locationId} and e.effective_at>=${start} and e.effective_at<=${end}
      group by e.movement_id,m.movement_number,m.movement_type,m.source_type,m.source_document_id,m.note,m.effective_at,m.status,m.posted_at
      having sum(abs(e.quantity_delta_base))<>0 or coalesce(sum(e.value_delta_minor),0)<>0
      order by m.effective_at,min(e.balance_version),m.posted_at,e.movement_id`;
    // running balance over the whole window, then page it (balances stay right on page 2)
    let q = number(opening.q),
      v = number(opening.v);
    const openingQ = q,
      openingV = v;
    /** @type {Array<{g:any,q:number,v:number}>} */
    const withBalance = grouped.map((/** @type {any} */ g) => {
      q += number(g.net);
      v += number(g.vd);
      return { g, q, v };
    });
    const pageRows = withBalance.slice(offset, offset + limit);
    // document numbers, one query per source type in view
    /** @type {Map<string,{number:string,label:string}>} */ const docs = new Map();
    for (const [sourceType, [table, col]] of Object.entries(DOCUMENT_TABLES)) {
      const wanted = [
        ...new Set(
          pageRows
            .filter((r) => r.g.source_type === sourceType)
            .map((r) => r.g.source_document_id),
        ),
      ].filter((s) => /^[0-9a-f-]{36}$/i.test(String(s)));
      if (!wanted.length) continue;
      const found = await db.unsafe(
        `select id::text as id,${col} as number from ${table} where id::text in (select jsonb_array_elements_text($1::text::jsonb))`,
        [JSON.stringify(wanted)],
      );
      for (const d of found)
        docs.set(`${sourceType}:${d.id}`, {
          number: d.number,
          label: DOCUMENT_TABLES[sourceType][2],
        });
    }
    const rows = pageRows.map((/** @type {{g:any,q:number,v:number}} */ { g, q: bal, v: valBal }) => {
      const net = number(g.net);
      const doc = docs.get(`${g.source_type}:${g.source_document_id}`);
      return {
        at: new Date(g.effective_at).getTime(),
        movementId: g.movement_id,
        movementNumber: g.movement_number,
        kind: g.movement_type,
        label: KIND_LABELS[g.movement_type] ?? g.movement_type,
        documentNumber: doc?.number ?? g.movement_number,
        documentLabel: doc?.label ?? "Stock movement",
        link: {
          type: doc ? g.source_type : "movement",
          id: doc ? g.source_document_id : g.movement_id,
        },
        note: g.note,
        reversed: g.movement_status === "reversed",
        in: net > 0 ? pres.quantity(net) : null,
        out: net < 0 ? pres.quantity(-net) : null,
        statusMoves:
          net === 0
            ? g.statuses
                .filter((/** @type {any} */ s) => Number(s.delta) !== 0)
                .map((/** @type {any} */ s) => ({
                  status: s.status,
                  delta: Number(s.delta),
                }))
            : [],
        balance: pres.quantity(bal),
        valueDeltaCentavos: number(g.vd),
        valueBalanceCentavos: valBal,
      };
    });
    const closingQ = openingQ + number(inRange.q),
      closingV = openingV + number(inRange.v);
    const [now] = await db`select physical_base,inventory_value_minor from inventory_balances where organization_id=${ORGANIZATION} and product_id=${productId} and location_id=${locationId}`;
    return {
      product: {
        id: productId,
        code: pres.product.code,
        name: pres.product.name,
        units: pres.units,
      },
      location: { id: loc.id, code: loc.code, name: loc.name },
      from,
      to,
      opening: { quantity: pres.quantity(openingQ), valueCentavos: openingV },
      rows,
      closing: { quantity: pres.quantity(closingQ), valueCentavos: closingV },
      totals: {
        in: pres.quantity(number(inRange.pos)),
        out: pres.quantity(number(inRange.neg)),
      },
      current: {
        quantity: pres.quantity(number(now?.physical_base ?? 0)),
        valueCentavos: number(now?.inventory_value_minor ?? 0),
      },
      // true when the card's closing line is today's balance (to >= today), a built-in drift check
      reconcilesToday:
        to < today ||
        (closingQ === number(now?.physical_base ?? 0) &&
          closingV === number(now?.inventory_value_minor ?? 0)),
      rowCount: grouped.length,
      nextCursor: offset + limit < grouped.length ? String(offset + limit) : null,
    };
  });
}

/** @param {import('../../core/router.js').Router} router */
export function installValuationRoutes(router) {
  router.get("/api/v1/inventory/valuation", valuation);
  router.get("/api/v1/inventory/stock-card", stockCard);
}
