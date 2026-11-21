// SP-0227 weekly truck stock: request -> served -> sold (existing van sales) -> Saturday count -> reconciliation.
// The cashier counts the salesman for what was actually SERVED; requested is kept for reference/shortfall.
// remittance_ref on truck_weeks is reserved for linking the separate cash remittance work later.
import { tx } from "@sunpride/db/client";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { ApiError, forbidden, invalid, conflict } from "../../core/errors.js";
import { OpRejected } from "../../core/sync.js";
import { canonicalJson, isPlainObject } from "../../core/util.js";
import { currentActor } from "../van/access.js";
import { scopeFilterForActor } from "../org/scope.js";
import { required, rule, uuid } from "../org/model.js";

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
 * that came back onto the truck subtracted). @param {any} db @param {string} seller @param {string} start */
export async function soldByProduct(db, seller, start) {
  const rows = await db`
    with trips as (
      select id from van_trips where salesperson_profile_id=${seller}
        and service_date between ${start}::date and ${start}::date + 6 and status<>'cancelled'),
    sold as (
      select l.product_id, sum(l.quantity_base)::bigint q from van_sale_lines l
        join van_sales s on s.id=l.sale_id where s.trip_id in (select id from trips)
        and not exists (select 1 from van_sale_voids v where v.sale_id=s.id) group by l.product_id),
    back as (
      select l.product_id, sum(l.quantity_base)::bigint q from van_return_lines l
        join van_returns r on r.id=l.return_id where r.trip_id in (select id from trips)
        and l.stock_status<>'none' group by l.product_id)
    select coalesce(s.product_id,b.product_id) as product_id, coalesce(s.q,0)-coalesce(b.q,0) as q
      from sold s full join back b on b.product_id=s.product_id`;
  return new Map(
    rows.map((/** @type {any} */ r) => [r.product_id, Number(r.q)]),
  );
}

/** One frozen-at-read reconciliation of a week. @param {any} db @param {any} week */
export async function weekDetail(db, week) {
  const lines =
    await db`select l.*,p.code,p.name,p.uom from truck_week_lines l join products p on p.id=l.product_id where l.week_id=${week.id} order by p.name,p.code`;
  const sold = await soldByProduct(
    db,
    week.salesperson_profile_id,
    manilaDayOfDate(week.week_start),
  );
  const out = lines.map((/** @type {any} */ l) => {
    const line = {
      productId: l.product_id,
      code: l.code,
      name: l.name,
      uom: l.uom,
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
        (variance !== 0 || line.countedBase > 0) &&
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
  return {
    id: week.id,
    weekStart: manilaDayOfDate(week.week_start),
    salespersonProfileId: week.salesperson_profile_id,
    seller: seller?.name ?? "",
    orgUnitId: week.org_unit_id,
    status: week.status,
    countedAt: week.counted_at ? +new Date(week.counted_at) : null,
    reviewedAt: week.reviewed_at ? +new Date(week.reviewed_at) : null,
    reviewNote: week.review_note,
    remittanceRef: week.remittance_ref,
    updatedAt: week.version,
    lines: out,
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
];
/** @param {any} d */
function csvRows(d) {
  return d.lines.map((/** @type {any} */ l) => [
    d.weekStart,
    d.seller,
    d.status,
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
  for (const w of weeks) rows.push(await weekDetail(c.db, w));
  const sellers = await c.db.unsafe(
    `select id,name,org_unit_id as "orgUnitId" from profiles where role='sales' and status='active' and deleted_at is null and ($1::uuid[] is null or org_unit_id=any($1::uuid[])) order by name limit 1000`,
    [units],
  );
  const products =
    await c.db`select id,code,name,uom from products where active order by name,code limit 2000`;
  return {
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
    return { all: await listWeeks(cc) };
  });
  if (c.url.searchParams.get("format") === "csv") {
    if (data.one)
      return csvResponse(
        csv([CSV_HEAD, ...csvRows(data.one)]),
        `truck-stock-${data.one.weekStart}.csv`,
      );
    const all = [CSV_HEAD];
    await tx(c.db, async (db) => {
      for (const r of data.all.rows) {
        const [w] = await db.unsafe(
          `select ${WEEK_COLS} from truck_weeks where id=$1`,
          [r.id],
        );
        all.push(...csvRows(await weekDetail(db, w)));
      }
    });
    return csvResponse(csv(all), `truck-stock-${data.all.weekStart}.csv`);
  }
  return data.one ?? data.all;
}

/** Office records what the salesman requested and what the warehouse actually served.
 * @param {any} c @param {any} b */
export async function saveWeek(c, b) {
  const start = weekStart(b.weekStart);
  const sellerId = uuid(b.salespersonProfileId);
  const [seller] =
    await c.db`select id,org_unit_id,role,status from profiles where id=${sellerId} and deleted_at is null`;
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
  const found =
    await c.db`select id from products where id = any(${c.db.array([...seen], "UUID")}::uuid[])`;
  if (found.length !== seen.size) rule("Choose existing products.");
  await c.db`select pg_advisory_xact_lock(hashtextextended(${"truckweek:" + sellerId + ":" + start},0))`;
  let [week] = await c.db.unsafe(
    `select ${WEEK_COLS} from truck_weeks where salesperson_profile_id=$1 and week_start=$2 for update`,
    [sellerId, start],
  );
  if (week) {
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
  const d = await weekDetail(c.db, w);
  const note =
    b.note == null || b.note === ""
      ? null
      : required(b.note, "Review note", 500);
  if (d.totals.missingReasons > 0 && !note)
    rule(
      "Some differences have no reason. Add a review note to close the week.",
    );
  await c.db`update truck_weeks set status='reviewed',reviewed_at=now(),reviewed_by=${c.actor.profileId},review_note=${note},updated_at=now() where id=${w.id}`;
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
          const [prior] =
            await db`select * from master_command_receipts where actor_profile_id=${actor.profileId} and command=${command} and request_key=${key}`;
          if (prior) {
            if (prior.payload_hash !== digest)
              throw new ApiError(
                "idempotency_conflict",
                409,
                "This request key was used for different details.",
              );
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
