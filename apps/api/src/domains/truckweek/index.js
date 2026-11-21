// SP-0227 weekly truck stock: request -> served -> sold (existing van sales) -> Saturday count -> reconciliation.
// The cashier counts the salesman for what was actually SERVED; requested is kept for reference/shortfall.
// remittance_ref on truck_weeks is reserved for linking the separate cash remittance work later.
import { tx } from "@sunpride/db/client";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError, forbidden, invalid, conflict } from "../../core/errors.js";
import { OpRejected } from "../../core/sync.js";
import { canonicalJson, isPlainObject } from "../../core/util.js";
import { currentActor, locationFor, tripFor } from "../van/access.js";
import { scopeFilterForActor } from "../org/scope.js";
import { required, rule, uuid } from "../org/model.js";
import { requestFacts, cashierFacts, printReport } from "./reports.js";

const MAX_LINES = 300;
const MAX_QTY = 100000000;

/** Manila calendar day for an instant. @param {number} ms */
export function manilaDay(ms) {
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
}
/** Monday of the week containing a YYYY-MM-DD day. @param {string} day */
export function mondayOf(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(+d - back * 86400000).toISOString().slice(0, 10);
}
/** @param {any} v */
export function weekStart(v) {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ||
    new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v
  )
    rule("Choose the week (YYYY-MM-DD).");
  if (mondayOf(v) !== v) rule("A stock week starts on a Monday.");
  return v;
}
/** @param {any} v @param {string} label */
function qty(v, label) {
  if (!Number.isSafeInteger(v) || v < 0 || v > MAX_QTY)
    rule(`${label} must be a whole number from 0.`);
  return v;
}

/** Variance = served − sold − counted. Positive: stock not accounted for; negative: extra stock.
 * @param {{servedBase:number,soldBase:number,countedBase:number|null}} l */
export function lineVariance(l) {
  return l.countedBase === null
    ? null
    : l.servedBase - l.soldBase - l.countedBase;
}

/** Net units sold from existing van sales in the week (voided sales excluded; customer returns
 * that came back onto the truck subtracted). @param {any} db @param {string} seller @param {string} start @param {string[]|null} [tripIds] */
export async function soldByProduct(db, seller, start, tripIds = null) {
  const rows = await db`
    with trips as (
      select id from van_trips where salesperson_profile_id=${seller}
        and service_date between ${start}::date and ${start}::date + 6 and status<>'cancelled'
        and deleted_at is null and (${tripIds === null} or id=any(${db.array(tripIds ?? [], "UUID")}::uuid[]))),
    sold as (
      select l.product_id, sum(l.quantity_base)::bigint q from van_sale_lines l
        join van_sales s on s.id=l.sale_id where s.trip_id in (select id from trips)
        and not exists (select 1 from van_sale_voids v where v.sale_id=s.id) group by l.product_id),
    back as (
      select l.product_id, sum(l.quantity_base)::bigint q from van_return_lines l
        join van_returns r on r.id=l.return_id where r.trip_id in (select id from trips)
        and l.stock_status<>'none' group by l.product_id),
    refunded as (select l.product_id,sum(l.quantity_base)::bigint q from sale_refund_lines l
      join sale_refunds r on r.id=l.refund_id where r.trip_id in (select id from trips) group by l.product_id),
    returns as (select product_id,sum(q)::bigint q from (select * from back union all select * from refunded) x group by product_id)
    select coalesce(s.product_id,b.product_id) as product_id, coalesce(s.q,0)-coalesce(b.q,0) as q
      from sold s full join returns b on b.product_id=s.product_id`;
  return new Map(
    rows.map((/** @type {any} */ r) => [r.product_id, Number(r.q)]),
  );
}

/** One frozen-at-read reconciliation of a week. @param {any} db @param {any} week */
export async function weekDetail(db, week) {
  if (week.closed_report) return week.closed_report;
  const tripIds = week.request_facts
    ? (
        await db`select trip_id from truck_week_trips where week_id=${week.id}`
      ).map((/** @type {any} */ r) => r.trip_id)
    : null;
  const lines =
    await db`select l.*,p.code,p.name,p.uom from truck_week_lines l join products p on p.id=l.product_id where l.week_id=${week.id} order by p.name,p.code`;
  const sold = await soldByProduct(
    db,
    week.salesperson_profile_id,
    manilaDayOfDate(week.week_start),
    tripIds,
  );
  const out = lines.map((/** @type {any} */ l) => {
    const frozen = week.request_facts?.products?.find(
      (/** @type {any} */ p) => p.productId === l.product_id,
    );
    const line = {
      quantityScale: frozen?.quantityScale ?? "1",
      productId: l.product_id,
      code: frozen?.code ?? l.code,
      name: frozen?.name ?? l.name,
      uom: frozen?.uomCode ?? l.uom,
      requestedBase: Number(l.requested_base),
      servedBase: Number(l.served_base),
      shortfallBase: Math.max(
        0,
        Number(l.requested_base) - Number(l.served_base),
      ),
      soldBase: sold.get(l.product_id) ?? 0,
      countedBase: l.counted_base === null ? null : Number(l.counted_base),
      reasonId: l.reason_id,
      reasonName: l.reason_name,
      note: l.count_note,
    };
    const variance = lineVariance(line);
    return {
      ...line,
      expectedLeftBase: line.servedBase - line.soldBase,
      varianceBase: variance,
      needsReason:
        line.countedBase !== null &&
        variance !== 0 &&
        !line.reasonId,
    };
  });
  // Sales of products the office never served still count as sold (and show as extra demand).
  for (const [productId, q] of sold)
    if (
      !out.some((/** @type {any} */ l) => l.productId === productId) &&
      q !== 0
    ) {
      const [p] =
        await db`select code,name,uom from products where id=${productId}`;
      out.push({
        productId,
        code: p.code,
        name: p.name,
        uom: p.uom,
        requestedBase: 0,
        servedBase: 0,
        shortfallBase: 0,
        soldBase: q,
        countedBase: week.status === "open" ? null : 0,
        reasonId: null,
        reasonName: null,
        note: null,
        expectedLeftBase: -q,
        varianceBase: week.status === "open" ? null : -q,
        needsReason: week.status !== "open",
        notLoaded: true,
      });
    }
  const sum = (/** @type {string} */ k) =>
    out.reduce(
      (/** @type {number} */ a, /** @type {any} */ l) => a + (l[k] ?? 0),
      0,
    );
  const [seller] =
    await db`select name from profiles where id=${week.salesperson_profile_id}`;
  const cashier = cashierFacts(week, out);
  const [pos] = await db`select
    (select coalesce(sum(s.total_centavos),0)::text from van_sales s where s.trip_id=any(${db.array(tripIds ?? [], "UUID")}::uuid[]) and not exists(select 1 from van_sale_voids v where v.sale_id=s.id)) as "invoicesMinor",
    ((select coalesce(sum(total_centavos),0) from sale_refunds where trip_id=any(${db.array(tripIds ?? [], "UUID")}::uuid[])) + (select coalesce(sum(amount_centavos),0) from van_payments where kind='refund' and trip_id=any(${db.array(tripIds ?? [], "UUID")}::uuid[])))::text as "refundsMinor"`;
  return {
    id: week.id,
    requestFacts: week.request_facts,
    cashier: { amountMinor: tripIds?.length ? cashier.amountMinor : null },
    pos: tripIds?.length ? pos : null,
    weekStart: manilaDayOfDate(week.week_start),
    salespersonProfileId: week.salesperson_profile_id,
    seller: week.request_facts?.seller ?? seller?.name ?? "",
    orgUnitId: week.org_unit_id,
    status: week.status,
    countedAt: week.counted_at ? +new Date(week.counted_at) : null,
    reviewedAt: week.reviewed_at ? +new Date(week.reviewed_at) : null,
    reviewNote: week.review_note,
    remittanceRef: week.remittance_ref,
    updatedAt: week.version,
    lines: cashier.lines,
    totals: {
      requestedBase: sum("requestedBase"),
      servedBase: sum("servedBase"),
      shortfallBase: sum("shortfallBase"),
      soldBase: sum("soldBase"),
      countedBase: week.status === "open" ? null : sum("countedBase"),
      varianceBase: week.status === "open" ? null : sum("varianceBase"),
      missingReasons: out.filter((/** @type {any} */ l) => l.needsReason)
        .length,
    },
  };
}
/** @param {any} d */
function manilaDayOfDate(d) {
  return d instanceof Date
    ? d.toISOString().slice(0, 10)
    : String(d).slice(0, 10);
}
const WEEK_COLS = `*,to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as version`;

/** Read a week the caller may see. @param {any} c @param {string} id @param {string} cap */
async function visibleWeek(c, id, cap, lock = false) {
  const [w] = await c.db.unsafe(
    `select ${WEEK_COLS} from truck_weeks where id=$1${lock ? " for update" : ""}`,
    [uuid(id)],
  );
  if (!w) throw forbidden("Stock week not found");
  await requireCapability(c, cap, w.org_unit_id);
  if (w.request_facts && cap !== "van.operate") {
    for (const id of [w.request_facts.depotId, w.request_facts.truckLocationId])
      await locationFor(c.db, c.actor, id, cap);
    for (const trip of w.request_facts.trips)
      await tripFor(c.db, c.actor, trip.id, cap);
  }
  return w;
}

/** CSV with formula protection that leaves plain numbers readable. @param {any[][]} rows */
export function csv(rows) {
  const cell = (/** @type {any} */ v) => {
    const s = String(v ?? "");
    if (/^-?\d+$/.test(s)) return s;
    return `"${s.replace(/^[=+\-@\t\r]/, "'$&").replaceAll('"', '""')}"`;
  };
  return (
    "\ufeff" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}
const CSV_HEAD = [
  "Week",
  "Salesman",
  "Status",
  "Product code",
  "Product",
  "Unit",
  "Requested",
  "Served",
  "Shortfall",
  "Sold",
  "Expected left",
  "Counted",
  "Variance",
  "Reason",
  "Note",
  "Quantity scale",
  "Accountable quantity",
  "Unit price (centavos)",
  "Accountability amount (centavos)",
];
/** Plain words for the stored week status (CSV is read by office staff). */
const STATUS_WORDS = /** @type {Record<string,string>} */ ({
  open: "Waiting for Saturday count",
  counted: "Counted, office to check",
  reviewed: "Checked and closed",
});
/** @param {any} d */
function csvRows(d) {
  return d.lines.map((/** @type {any} */ l) => [
    d.weekStart,
    d.seller,
    STATUS_WORDS[d.status] ?? d.status,
    l.code,
    l.name,
    l.uom,
    l.requestedBase,
    l.servedBase,
    l.shortfallBase,
    l.soldBase,
    l.expectedLeftBase,
    l.countedBase ?? "",
    l.varianceBase ?? "",
    l.reasonName ?? (l.needsReason ? "No reason given" : ""),
    l.note ?? "",
    l.quantityScale ?? "1",
    l.accountableBase ?? "",
    l.unitPriceMinor ?? "",
    l.accountableMinor ?? "",
  ]);
}
/** @param {string} text @param {string} name */
function csvResponse(text, name) {
  return new Response(text, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename=${name}`,
    },
  });
}

/** Office list for a week: every scoped salesman's stock week plus who can be added. @param {any} c */
export async function listWeeks(c) {
  const start = weekStart(c.url.searchParams.get("weekStart"));
  await requireCapability(c, "van.read");
  const scope = await scopeFilterForActor(c.db, c.actor);
  const units = scope.unitIds ? `{${scope.unitIds.join(",")}}` : null;
  const weeks = await c.db.unsafe(
    `select ${WEEK_COLS} from truck_weeks where week_start=$1 and ($2::uuid[] is null or org_unit_id=any($2::uuid[])) order by created_at,id limit 501`,
    [start, units],
  );
  if (weeks.length > 500)
    throw conflict("Too many stock weeks; narrow your scope");
  const rows = [];
  for (const w of weeks) {
    await visibleWeek(c, w.id, "van.read");
    rows.push(await weekDetail(c.db, w));
  }
  const sellers = await c.db.unsafe(
    `select id,name,org_unit_id as "orgUnitId" from profiles where role='sales' and status='active' and deleted_at is null and ($1::uuid[] is null or org_unit_id=any($1::uuid[])) order by name limit 1000`,
    [units],
  );
  const products =
    await c.db`select id,code,name,uom from products where active order by name,code limit 2000`;
  const vehicles = await c.db.unsafe(
    `select id,vehicle_code as name,org_unit_id as "orgUnitId" from vehicles where status='active' and deleted_at is null and ($1::uuid[] is null or org_unit_id=any($1::uuid[])) order by vehicle_code limit 1001`,
    [units],
  );
  const trips = await c.db.unsafe(
    `select id,trip_number as name,service_date::text as "serviceDate",vehicle_id as "vehicleId",salesperson_profile_id as "salespersonProfileId" from van_trips where service_date between $1::date and $1::date+5 and status<>'cancelled' and deleted_at is null and ($2::uuid[] is null or org_unit_id=any($2::uuid[])) order by service_date,id limit 1001`,
    [start, units],
  );
  if (
    vehicles.length > 1000 ||
    trips.length > 1000 ||
    sellers.length >= 1000 ||
    products.length >= 2000
  )
    throw conflict(
      "Too many choices; narrow your scope before preparing stock.",
    );
  const channels =
    await c.db`select distinct payload->'data'->>'channelKey' as name from sap_replicas where kind='condition' and deleted_at is null and payload->'data'->>'channelKey' is not null order by name limit 501`;
  if (channels.length > 500) throw conflict("Too many pricing channels.");
  return {
    vehicles,
    trips,
    priceChannels: channels.map((/** @type {any} */ r) => r.name),
    weekStart: start,
    canManage: roleHas(c.actor.role, "van.manage"),
    rows: rows.map((r) => ({
      ...r,
      lines: undefined,
      lineCount: r.lines.length,
    })),
    sellers,
    products,
  };
}

/** @param {any} c */
export async function weekRead(c) {
  const data = await tx(c.db, async (db) => {
    const cc = { ...c, db, actor: await currentActor(db, c.actor) };
    if (c.url.searchParams.get("id")) {
      const w = await visibleWeek(
        cc,
        String(c.url.searchParams.get("id")),
        "van.read",
      );
      return { one: await weekDetail(db, w) };
    }
    const all = await listWeeks(cc);
    const exportRows = [CSV_HEAD];
    if (c.url.searchParams.get("format") === "csv") {
      for (const r of all.rows) {
        const w = await visibleWeek(cc, r.id, "van.read");
        exportRows.push(...csvRows(await weekDetail(db, w)));
      }
    }
    return { all, exportRows };
  });
  if (c.url.searchParams.get("format") === "csv") {
    if (data.one)
      return csvResponse(
        csv([CSV_HEAD, ...csvRows(data.one)]),
        `truck-stock-${data.one.weekStart}.csv`,
      );
    if (!data.all || !data.exportRows)
      throw invalid("Choose a week to export.");
    return csvResponse(
      csv(data.exportRows),
      `truck-stock-${data.all.weekStart}.csv`,
    );
  }
  if (c.url.searchParams.get("format") === "print") {
    if (!data.one) throw invalid("Open a salesman stock week before printing.");
    return new Response(
      printReport(data.one, c.url.searchParams.get("report") ?? "count"),
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "private, no-store",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
  return data.one ?? data.all;
}

/** Office records what the salesman requested and what the warehouse actually served.
 * @param {any} c @param {any} b */
export async function saveWeek(c, b) {
  const start = weekStart(b.weekStart);
  const sellerId = uuid(b.salespersonProfileId);
  const [seller] =
    await c.db`select id,name,org_unit_id,role,status from profiles where id=${sellerId} and deleted_at is null`;
  if (!seller || seller.status !== "active" || seller.role !== "sales")
    rule("Choose an active salesman.");
  await requireCapability(c, "van.manage", seller.org_unit_id);
  if (
    !Array.isArray(b.lines) ||
    b.lines.length < 1 ||
    b.lines.length > MAX_LINES
  )
    rule(`Enter 1 to ${MAX_LINES} products.`);
  const seen = new Set();
  const lines = b.lines.map((/** @type {any} */ l) => {
    if (!isPlainObject(l)) rule("Enter each product line.");
    const productId = uuid(l.productId);
    if (seen.has(productId)) rule("Each product can appear once.");
    seen.add(productId);
    const requestedBase = qty(l.requestedBase, "Requested quantity");
    const servedBase = qty(l.servedBase, "Served quantity");
    return { productId, requestedBase, servedBase };
  });
  if (
    lines.some((/** @type {any} */ l) => l.servedBase > 0) &&
    (!Array.isArray(b.tripIds) || b.tripIds.length === 0)
  )
    rule("Choose the week's POS trips before recording served stock.");
  const found =
    await c.db`select id from products where id = any(${c.db.array([...seen], "UUID")}::uuid[])`;
  if (found.length !== seen.size) rule("Choose existing products.");
  await c.db`select pg_advisory_xact_lock(hashtextextended(${"truckweek:" + sellerId + ":" + start},0))`;
  let [week] = await c.db.unsafe(
    `select ${WEEK_COLS} from truck_weeks where salesperson_profile_id=$1 and week_start=$2 for update`,
    [sellerId, start],
  );
  if (week) {
    await visibleWeek(c, week.id, "van.manage");
    if (week.status === "reviewed")
      rule("This week was already reviewed by the office and is closed.");
    if (week.version !== b.baseUpdatedAt)
      rule("This stock week changed. Reload before saving.");
    await c.db`update truck_weeks set updated_by=${c.actor.profileId},updated_at=now() where id=${week.id}`;
  } else {
    if (b.baseUpdatedAt) rule("This stock week changed. Reload before saving.");
    [week] =
      await c.db`insert into truck_weeks(salesperson_profile_id,org_unit_id,week_start,created_by,updated_by) values(${sellerId},${seller.org_unit_id},${start},${c.actor.profileId},${c.actor.profileId}) returning id`;
  }
  if (week.status === "counted")
    rule(
      "The Saturday count is recorded. Review it before changing the stock request.",
    );
  const [loaded] =
    await c.db`select 1 from truck_week_lines where week_id=${week.id} and served_base>0 limit 1`;
  let facts;
  if (loaded && week.request_facts) {
    const old = week.request_facts;
    const order = (/** @type {any[]} */ values) =>
      [...values].sort((a, b) => a.productId.localeCompare(b.productId));
    const requested = lines.map((/** @type {any} */ l) => ({
      productId: l.productId,
      requestedBase: l.requestedBase,
    }));
    const prior = old.products.map((/** @type {any} */ l) => ({
      productId: l.productId,
      requestedBase: l.requestedBase,
    }));
    if (
      b.vehicleId !== old.vehicleId ||
      (b.priceChannel || null) !== old.priceChannel ||
      (b.sapOrderReference ?? "").trim() !== old.sapOrderReference ||
      canonicalJson([...(b.tripIds ?? [])].sort()) !==
        canonicalJson(old.trips.map((/** @type {any} */ t) => t.id).sort()) ||
      canonicalJson(order(requested)) !== canonicalJson(order(prior))
    )
      rule(
        "The request facts are fixed once stock is served. Keep the same products, requested quantities, truck and trips.",
      );
    facts = old;
  } else facts = await requestFacts(c, b, start, seller, lines);
  await c.db`update truck_weeks set request_facts=${facts} where id=${week.id}`;
  await c.db`delete from truck_week_trips where week_id=${week.id}`;
  for (const trip of facts.trips) {
    const [taken] =
      await c.db`select week_id from truck_week_trips where trip_id=${trip.id}`;
    if (taken) rule("A trip already belongs to another stock week.");
    await c.db`insert into truck_week_trips(week_id,trip_id) values(${week.id},${trip.id})`;
  }
  const old =
    await c.db`select product_id,counted_base from truck_week_lines where week_id=${week.id}`;
  const counted = old.filter((/** @type {any} */ r) => r.counted_base !== null);
  for (const r of counted)
    if (!seen.has(r.product_id))
      rule(
        "A counted product cannot be removed; set its served quantity to 0.",
      );
  await c.db`delete from truck_week_lines where week_id=${week.id} and product_id <> all(${c.db.array([...seen], "UUID")}::uuid[])`;
  for (const l of lines)
    await c.db`insert into truck_week_lines(week_id,product_id,requested_base,served_base) values(${week.id},${l.productId},${l.requestedBase},${l.servedBase})
      on conflict(week_id,product_id) do update set requested_base=excluded.requested_base,served_base=excluded.served_base,updated_at=now()`;
  await c.db`insert into truck_week_report_events(week_id,actor_profile_id,kind,facts) values(${week.id},${c.actor.profileId},'request_saved',${{ request: facts, lines }})`;
  await c.change("truckweek.bundle", week.id, `profile:${sellerId}`);
  return { id: week.id };
}

/** Office closes the week after checking the Saturday count. @param {any} c @param {any} b */
export async function reviewWeek(c, b) {
  const w = await visibleWeek(c, b.id, "van.manage", true);
  if (w.status !== "counted")
    rule("Review a week after the salesman's Saturday count.");
  if (w.version !== b.baseUpdatedAt)
    rule("This stock week changed. Reload before saving.");
  const trips =
    await c.db`select t.id,t.status from truck_week_trips x join van_trips t on t.id=x.trip_id where x.week_id=${w.id} order by t.id for update of t`;
  if (trips.some((/** @type {any} */ t) => t.status !== "closed"))
    rule("Close the linked POS trips before freezing the cashier report.");
  const d = await weekDetail(c.db, w);
  const note =
    b.note == null || b.note === ""
      ? null
      : required(b.note, "Review note", 500);
  if (d.totals.missingReasons > 0 && !note)
    rule(
      "Some differences have no reason. Add a review note to close the week.",
    );
  const frozen = {
    ...d,
    status: "reviewed",
    reviewedAt: c.now,
    reviewNote: note,
  };
  await c.db`update truck_weeks set status='reviewed',reviewed_at=${new Date(c.now)},reviewed_by=${c.actor.profileId},review_note=${note},closed_report=${frozen},updated_at=now() where id=${w.id}`;
  await c.db`insert into truck_week_report_events(week_id,actor_profile_id,kind,facts) values(${w.id},${c.actor.profileId},'reviewed',${frozen})`;
  await c.change(
    "truckweek.bundle",
    w.id,
    `profile:${w.salesperson_profile_id}`,
  );
  return { id: w.id };
}

/** Phone bundle: this salesman's own week containing the service day, plus active reasons.
 * @param {any} c */
export async function fieldWeek(c) {
  const day = c.params.serviceDate;
  if (day !== manilaDay(c.now)) throw invalid("Refresh today's truck stock");
  await requireCapability(c, "van.operate", c.actor.orgUnitId ?? null);
  const start = mondayOf(day);
  const [w] = await c.db.unsafe(
    `select ${WEEK_COLS} from truck_weeks where salesperson_profile_id=$1 and week_start=$2`,
    [c.actor.profileId, start],
  );
  if (w) await requireCapability(c, "van.operate", w.org_unit_id);
  const reasons =
    await c.db`select id,name from truck_stock_reasons where active order by sort_order,name`;
  return {
    profileId: c.actor.profileId,
    serviceDate: day,
    weekStart: start,
    week: w ? await weekDetail(c.db, w) : null,
    reasons,
  };
}

/** @param {any} db @param {any} actor @param {any} op */
export async function guardCount(db, actor, op) {
  try {
    const p = op.payload,
      now = Date.now();
    if (
      !isPlainObject(p) ||
      op.clientTime > now + 60000 ||
      op.clientTime < now - 14 * 86400000
    )
      throw invalid("Count must be recent");
    actor = await currentActor(db, actor);
    const c = { db, actor, now };
    const w = await visibleWeek(
      c,
      String(/** @type {any} */ (p).weekId),
      "van.operate",
      true,
    );
    if (w.salesperson_profile_id !== actor.profileId)
      throw forbidden("This is not your stock week");
  } catch (e) {
    if (e instanceof ApiError)
      throw new OpRejected(
        e.status === 403 || e.status === 404
          ? "out_of_scope"
          : "invalid_request",
      );
    throw e;
  }
}

/** Saturday count from the Field app. A later count replaces an earlier one until the office reviews.
 * @param {any} c */
export async function captureCount(c) {
  try {
    const p = c.payload;
    const w = await visibleWeek(c, p.weekId, "van.operate", true);
    if (w.salesperson_profile_id !== c.actor.profileId)
      throw forbidden("This is not your stock week");
    if (w.status === "reviewed")
      throw invalid("The office already closed this week");
    const lines =
      await c.db`select product_id from truck_week_lines where week_id=${w.id}`;
    const expected = new Set(lines.map((/** @type {any} */ l) => l.product_id));
    if (!Array.isArray(p.lines) || p.lines.length !== expected.size)
      throw invalid("Count every served product");
    const seen = new Set();
    for (const l of p.lines) {
      if (
        !isPlainObject(l) ||
        !expected.has(l.productId) ||
        seen.has(l.productId)
      )
        throw invalid("Count every served product once");
      seen.add(l.productId);
      qty(l.countedBase, "Counted quantity");
      let reasonName = null;
      if (l.reasonId != null) {
        const [r] =
          await c.db`select name from truck_stock_reasons where id=${uuid(l.reasonId)}`;
        if (!r) throw invalid("Choose a listed reason");
        reasonName = r.name;
      }
      const note =
        l.note == null || l.note === "" ? null : required(l.note, "Note", 300);
      await c.db`update truck_week_lines set counted_base=${l.countedBase},reason_id=${l.reasonId ?? null},reason_name=${reasonName},count_note=${note},updated_at=now() where week_id=${w.id} and product_id=${l.productId}`;
    }
    await c.db`update truck_weeks set status='counted',counted_at=${new Date(c.op.clientTime)},counted_client_op_id=${c.op.clientOpId},updated_at=now() where id=${w.id}`;
    await c.db`insert into truck_week_report_events(week_id,actor_profile_id,kind,facts) values(${w.id},${c.actor.profileId},'counted',${{ lines: p.lines, clientOpId: c.op.clientOpId }})`;
    c.change("truckweek.bundle", w.id, `profile:${c.actor.profileId}`);
    c.publish("van");
    return { entityId: w.id };
  } catch (e) {
    if (e instanceof ApiError)
      throw new OpRejected(
        e.status === 403 || e.status === 404
          ? "out_of_scope"
          : "invalid_request",
      );
    throw e;
  }
}

/** @param {any} router @param {any} platform */
export function install(router, platform) {
  platform.registerProjection("field.truckweek", {
    params: (/** @type {any} */ p) => ({
      serviceDate: required(p?.serviceDate, "Day", 10),
    }),
    snapshot: async (/** @type {any} */ c) => ({
      data: await fieldWeek(c),
      next: null,
    }),
  });
  platform.registerOp("truckweek.capture", captureCount, guardCount);
  router.get("/api/v1/truck-weeks", weekRead);
  /** @param {string} name @param {(c:any,b:any)=>Promise<any>} handler */
  function command(name, handler) {
    router.post(
      `/api/v1/truck-weeks/${name}`,
      async (/** @type {any} */ ctx) => {
        if (!isPlainObject(ctx.body)) rule("Enter a valid command.");
        const result = await tx(ctx.db, async (db) => {
          const actor = await currentActor(db, ctx.actor);
          await requireCapability({ db, actor }, "van.manage");
          const key = required(
            ctx.req.headers.get("idempotency-key"),
            "Request key",
            128,
          );
          const digest = new Bun.CryptoHasher("sha256")
            .update(canonicalJson(ctx.body))
            .digest("hex");
          const command = `truckweek/${name}`;
          await db`select pg_advisory_xact_lock(hashtextextended(${actor.profileId + ":" + command + ":" + key},0))`;
          const [prior] =
            await db`select * from master_command_receipts where actor_profile_id=${actor.profileId} and command=${command} and request_key=${key}`;
          if (prior) {
            if (prior.payload_hash !== digest)
              throw new ApiError(
                "idempotency_conflict",
                409,
                "This request key was used for different details.",
              );
            await visibleWeek({ db, actor }, prior.result.id, "van.manage");
            return prior.result;
          }
          const c = {
            ...ctx,
            db,
            actor,
            change: (
              /** @type {string} */ entity,
              /** @type {string} */ entityId,
              /** @type {string} */ scopeKey,
            ) =>
              platform.recordChange(db, {
                entity,
                entityId,
                scopeKey,
                op: "upsert",
              }),
          };
          const value = await handler(c, ctx.body);
          await db`insert into master_command_receipts(actor_profile_id,command,request_key,payload_hash,result) values(${actor.profileId},${command},${key},${digest},${value})`;
          return value;
        });
        await ctx.publish("van");
        return result;
      },
    );
  }
  command("save", saveWeek);
  command("review", reviewWeek);
}
