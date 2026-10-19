import {
  requireCapability,
  CROSS_SCOPE_ROLES,
} from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { hooks } from "../../core/hooks.js";
import { salesSource } from "./read-model.js";
import { readTiles } from "./tiles.js";

export const VERSION = "analytics/v2/2026-10-19";
export const DAY = 86_400_000;
/** @param {any} n */
export const num = (n) => (n == null ? null : Number(n));
/** @param {any} t */
export const ms = (t) => (t == null ? null : new Date(t).getTime());
/** @param {any} t */
export const dateOf = (t) =>
  new Date(new Date(t).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
/** @param {string} d @param {number} n */
export const addDays = (d, n) =>
  new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
/** @param {string} a @param {string} b */
export const daysBetween = (a, b) =>
  Math.round((Date.parse(b) - Date.parse(a)) / DAY);
/** @param {string} d */
export function validDate(d) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
    !Number.isFinite(Date.parse(d)) ||
    new Date(d).toISOString().slice(0, 10) !== d
  )
    throw new ApiError("invalid_date", 400, "Use a valid YYYY-MM-DD date");
  return d;
}
/** @param {string} a @param {string} b */
export function dates(a, b) {
  const out = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}
/** Port of sfa/selling_days.ts: Saturday counts, Sunday does not. @param {string} d */
export const sellingDay = (d) => new Date(d + "T00:00:00Z").getUTCDay() !== 0;
/** @param {string} a @param {string} b */
export const sellingDays = (a, b) =>
  b < a ? 0 : dates(a, b).filter(sellingDay).length;
/** @param {string} m */
export const monthEnd = (m) =>
  new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
/** @param {number} amount @param {string} month @param {string} from @param {string} to */
export function prorate(amount, month, from, to) {
  // Integer centavo apportionment: cumulative rounding avoids day/month drift.
  const start = month + "-01",
    end = monthEnd(month),
    total = sellingDays(start, end);
  const before =
    from <= start
      ? 0
      : sellingDays(start, addDays(from <= end ? from : addDays(end, 1), -1));
  const through = to < start ? 0 : sellingDays(start, to < end ? to : end);
  return (
    Math.round((amount * through) / total) -
    Math.round((amount * before) / total)
  );
}
/** @param {number|null} a @param {number|null} b */
export const pct = (a, b) =>
  a == null || b == null || b === 0 ? null : Math.round((a / b) * 1000) / 10;
/** @param {number|null} a @param {number|null} b */
export const delta = (a, b) =>
  a == null || b == null || b === 0
    ? null
    : Math.round(((a - b) / Math.abs(b)) * 1000) / 10;
/** @param {number|null} value @param {number|null} target */
export const status = (value, target) =>
  value == null || target == null
    ? "unknown"
    : target === 0
      ? value >= 0
        ? "ok"
        : "behind"
      : value / target < 0.9
        ? "behind"
        : value / target < 1
          ? "watch"
          : "ok";
/** @param {string} key @param {string} label @param {number|null} value @param {string} unit @param {number|null} target @param {number|null} prior @param {string} definition */
export const kpi = (key, label, value, unit, target, prior, definition) => ({
  key,
  label,
  value,
  unit,
  target,
  prior,
  deltaPct: delta(value, prior),
  status: status(value, target),
  definition,
});
/** @param {any[]} rows @param {string} key */
export const sum = (rows, key) =>
  rows.reduce((n, r) => n + Number(r[key] ?? 0), 0);
/** @param {any[]} rows @param {string} key */
export const knownSum = (rows, key) =>
  rows.length && rows.every((r) => r[key] != null) ? sum(rows, key) : null;
/** @param {any[]} rows @param {string} key */
export const minTime = (rows, key) => {
  const t = rows.map((r) => ms(r[key])).filter((t) => t != null);
  return t.length ? Math.min(.../** @type {number[]} */ (t)) : null;
};
/** @param {any[]} rows @param {string} key */
export const maxTime = (rows, key) => {
  const t = rows.map((r) => ms(r[key])).filter((t) => t != null);
  return t.length ? Math.max(.../** @type {number[]} */ (t)) : null;
};

/** Authoritative current scope, narrowed (never widened) by the URL. @param {any} ctx */
export async function scopeFor(ctx) {
  const actor = await requireCapability(ctx, "report.read");
  const hookIds = await hooks.scopeUnitIds(ctx.db, actor);
  let ids = CROSS_SCOPE_ROLES.includes(actor.role)
    ? (await ctx.db`select id from org_units where deleted_at is null`).map(
        (/** @type {any} */ r) => r.id,
      )
    : hookIds;
  const requested = ctx.url.searchParams.get("unitId");
  if (requested) {
    if (!ids.includes(requested))
      throw new ApiError("out_of_scope", 403, "This area is outside your team");
    const sub = await ctx.db`with recursive subtree as (
      select id from org_units where id=${requested}
      union select u.id from org_units u join subtree s on coalesce((select e.parent_id from org_unit_parent_edges e where e.unit_id=u.id and e.deleted_at is null and e.effective_from<=now() and (e.effective_to is null or e.effective_to>now()) order by e.effective_from desc limit 1),u.parent_id)=s.id
      where u.deleted_at is null) select id from subtree`;
    const allowed = new Set(sub.map((/** @type {any} */ r) => r.id));
    ids = ids.filter((/** @type {string} */ id) => allowed.has(id));
  }
  const root = requested ?? actor.orgUnitId;
  const label = root
    ? ((await ctx.db`select name from org_units where id=${root}`)[0]?.name ??
      "Your team")
    : "Company";
  return {
    ids: /** @type {string[]} */ (ids),
    unitId: root ?? null,
    label,
    ownProfileId: actor.role === "sales" ? actor.profileId : null,
    cross: CROSS_SCOPE_ROLES.includes(actor.role) && !requested,
    companyScope:
      actor.role !== "sales" &&
      !requested &&
      (
        await ctx.db`select id from org_units where code='SUNPRIDE' and organization_id='sunpride' and deleted_at is null`
      ).some((/** @type {any} */ u) => ids.includes(u.id)),
  };
}
/** @param {any} ctx @param {boolean} [day] */
export function periodFor(ctx, day = false) {
  const q = ctx.url.searchParams,
    today = dateOf(ctx.now);
  const date = validDate(q.get("date") ?? today);
  const from = validDate(
    day ? date : (q.get("from") ?? today.slice(0, 7) + "-01"),
  );
  const to = validDate(day ? date : (q.get("to") ?? today));
  const days = daysBetween(from, to) + 1;
  if (days < 1 || days > 366)
    throw new ApiError(
      "invalid_period",
      400,
      "Choose a period of one to 366 days",
    );
  const compare = q.get("compare") ?? "prior";
  if (!["prior", "ly"].includes(compare))
    throw new ApiError("invalid_compare", 400, "Choose prior or ly");
  // Feb 29 clips to Feb 28, rather than rolling into March.
  const ly = (/** @type {string} */ d) => {
    const y = String(Number(d.slice(0, 4)) - 1),
      m = y + d.slice(4, 7);
    return (
      m +
      "-" +
      String(
        Math.min(Number(d.slice(8)), Number(monthEnd(m).slice(8))),
      ).padStart(2, "0")
    );
  };
  return {
    from,
    to,
    days,
    elapsedDays: Math.max(0, Math.min(days, daysBetween(from, today) + 1)),
    remainingSellingDays: sellingDays(
      today < from ? from : addDays(today, 1),
      to,
    ),
    compare:
      compare === "ly"
        ? { from: ly(from), to: ly(to) }
        : { from: addDays(from, -days), to: addDays(from, -1) },
    channel: q.get("channel"),
    today,
  };
}
/** @param {any} ctx @param {any} p @param {any} s */
export async function header(ctx, p, s) {
  const [devices, demo] = await Promise.all([
    ctx.db`select count(*) filter(where last_seen_at is null or last_seen_at<${new Date(ctx.now - 30 * 60_000)}) as behind,min(last_seen_at) as oldest from registered_devices where status='active' and org_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])} and (${s.ownProfileId}::uuid is null or profile_id=${s.ownProfileId})`,
    ctx.db`select exists(select 1 from sample_data_rows r join analytics_store_scope o on o.id::text=r.row_id and r.table_name='outlets' where o.owner_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])}) as demo`,
  ]);
  return {
    period: {
      from: p.from,
      to: p.to,
      days: p.days,
      elapsedDays: p.elapsedDays,
      remainingSellingDays: p.remainingSellingDays,
    },
    compare: p.compare,
    scope: { unitId: s.unitId, label: s.label },
    freshness: {
      asOf: ctx.now,
      devicesBehind: Number(devices[0].behind),
      oldestDeviceSyncAt: ms(devices[0].oldest),
    },
    demo: Boolean(demo[0].demo),
  };
}

export const GROUPS = [
  "channel",
  "territory",
  "agent",
  "category",
  "sku",
  "store",
];
/** @param {string} group */
function groupSql(group) {
  const expressions = /** @type {Record<string,string[]>} */ ({
    channel: ["channel", "channel"],
    territory: ["territory_id::text", "territory_name"],
    agent: ["profile_id::text", "agent_name"],
    category: ["category", "category"],
    sku: ["product_id::text", "product_name"],
    store: ["store_id::text", "store_name"],
  });
  const v = expressions[group];
  if (!v) throw new ApiError("invalid_group", 400, "Unknown sales grouping");
  return v;
}
/** Shared sales definition: source line net centavos, same query on every page. @param {any} db @param {any} p @param {any} s @param {string} [group] @param {string|null} [parent] */
export async function readSales(db, p, s, group = "channel", parent = null) {
  s.salesReads ??= new Map();
  const key = JSON.stringify([
    p.from,
    p.to,
    p.channel,
    s.ownProfileId,
    group,
    parent,
  ]);
  if (!s.salesReads.has(key)) {
    // Bun 1.3 can strand concurrent executions of the same prepared statement on one
    // transaction connection. Serialize this family, while retaining request memoization.
    const work = (s.salesQueue ?? Promise.resolve()).then(() =>
      querySales(db, p, s, group, parent),
    );
    s.salesQueue = work.then(
      () => undefined,
      () => undefined,
    );
    s.salesReads.set(key, work);
  }
  return s.salesReads.get(key);
}
/** @param {any} db @param {any} p @param {any} s @param {string} group @param {string|null} parent */
async function querySales(db, p, s, group, parent) {
  const [key, label] = groupSql(group);
  let parentExpr = "true",
    parentKey = null;
  if (parent) {
    const i = parent.indexOf(":"),
      g = parent.slice(0, i);
    if (i < 1)
      throw new ApiError("invalid_parent", 400, "Use group:key for drill-down");
    parentExpr = `coalesce(${groupSql(g)[0]},'unassigned')=$6`;
    parentKey = parent.slice(i + 1);
  }
  let source = await salesSource(db, p, s);
  if (
    source === "tiles" &&
    (!parent ||
      ["channel", "territory", "agent"].includes(parent.split(":")[0]) ||
      (group === "store" && parent.startsWith("store:")))
  )
    return readTiles(db, p, s, group, parent);
  source = "analytics_sales_facts";
  const sql = `with facts as (select service_date,${key} as group_key,${label} as group_label,sales_centavos,approved,posted,order_id,customer_code,store_id,quantity from ${source} where service_date between $1::date and $2::date
    and agent_unit_id=any($3::uuid[]) and (owner_unit_id=any($3::uuid[]) or (store_id is null and $7::boolean))
    and (source_location_id is null or source_unit_id=any($3::uuid[]))
    and ($4::text is null or channel=$4) and ($5::uuid is null or profile_id=$5)
    and ${parentExpr} and ($6::text is null or true)),
  groups as (
    select 'total' as section,'total' as key,'Total' as label,sum(sales_centavos) as sales,
      sum(sales_centavos) filter(where approved) as approved,sum(sales_centavos) filter(where posted) as posted,
      count(distinct order_id) as orders,count(*) as lines,count(distinct customer_code) filter(where sales_centavos>0) as ubo,sum(quantity) as quantity,count(distinct store_id) as stores,null::text[] as buyers from facts
    union all
    select 'day',service_date::text,service_date::text,sum(sales_centavos),sum(sales_centavos) filter(where approved),sum(sales_centavos) filter(where posted),count(distinct order_id),count(*),count(distinct customer_code) filter(where sales_centavos>0),sum(quantity),count(distinct store_id),array_agg(distinct customer_code) filter(where sales_centavos>0) from facts group by service_date
    union all
    select 'group',coalesce(group_key,'unassigned'),coalesce(group_label,'Unassigned'),sum(sales_centavos),sum(sales_centavos) filter(where approved),sum(sales_centavos) filter(where posted),count(distinct order_id),count(*),count(distinct customer_code) filter(where sales_centavos>0),sum(quantity),count(distinct store_id),null::text[] from facts group by 2,3)
  select * from groups`;
  const rs = await db.unsafe(sql, [
    p.from,
    p.to,
    `{${s.ids.join(",")}}`,
    p.channel ?? null,
    s.ownProfileId,
    parentKey,
    s.cross,
  ]);
  const normalized = rs.map((/** @type {any} */ r) => ({
    ...r,
    sales: Number(r.sales ?? 0),
    approved: Number(r.approved ?? 0),
    posted: Number(r.posted ?? 0),
    orders: Number(r.orders),
    lines: Number(r.lines),
    ubo: Number(r.ubo),
    stores: Number(r.stores),
    quantity: Number(r.quantity ?? 0),
  }));
  return {
    total: normalized.find((/** @type {any} */ r) => r.section === "total"),
    days: normalized.filter((/** @type {any} */ r) => r.section === "day"),
    rows: normalized.filter((/** @type {any} */ r) => r.section === "group"),
  };
}
/** Safe RFC-4180, protect every textual cell (including whitespace-prefixed formulas). @param {any[]} rows */
export function csv(rows) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (/** @type {any} */ v) => {
    let t =
      v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
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
        "content-disposition": 'attachment; filename="analytics.csv"',
        "cache-control": "no-store",
      },
    },
  );
}
