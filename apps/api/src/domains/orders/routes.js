import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { b64url, canonicalJson, sha256Hex, unb64url } from "../../core/util.js";
import {
  ORDER_ACCESS,
  ORDER_FROM,
  accessibleOrder,
  scopeParams,
} from "./access.js";
import { command, createOrder, notify, transition } from "./service.js";
import { csv, date, fail, manilaDate, text, uuid } from "./validation.js";

/** @param {any} o */
export function orderView(o) {
  return {
    id: o.id,
    orderNumber: o.order_number,
    status: o.status,
    customerCode: o.customer_code,
    customerName: o.customer_name ?? "Former customer",
    salespersonName: o.salesperson_name ?? "Former user",
    salespersonProfileId: o.salesperson_profile_id,
    channel: o.channel_key,
    territoryName: o.territory_name,
    territoryId: o.territory_id,
    serviceDate: o.service_date
      ? new Date(o.service_date).toISOString().slice(0, 10)
      : manilaDate(new Date(o.created_at)),
    totalCentavos: o.amount_known
      ? Number(o.total_centavos ?? Math.round(Number(o.total) * 100))
      : null,
    creditStatus: o.credit_status ?? "unknown",
    createdAt: new Date(o.created_at).getTime(),
    canCountAsCall: false,
    source:
      o.order_type === "outside_call"
        ? "Office outside-call PO"
        : o.order_type === "field_order"
          ? "Field order"
          : "Booked order",
  };
}
/** @param {any} ctx */
export async function list(ctx) {
  const params = await scopeParams(ctx);
  const q = ctx.url.searchParams;
  const from = q.get("from")
    ? date(q.get("from"))
    : manilaDate(ctx.now).slice(0, 7) + "-01";
  const to = q.get("to") ? date(q.get("to")) : manilaDate(ctx.now);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
  if (days < 1 || days > 366) fail("Choose a period of 1–366 days");
  const priorFrom = new Date(Date.parse(from) - days * 86400_000)
    .toISOString()
    .slice(0, 10);
  const priorTo = new Date(Date.parse(from) - 86400_000)
    .toISOString()
    .slice(0, 10);
  const view = q.get("view");
  const status =
    view === "waiting"
      ? "pending_approval"
      : view === "rejected"
        ? "rejected"
        : q.get("status");
  const filters = [
    status,
    q.get("salesperson"),
    q.get("customer"),
    q.get("channel"),
    q.get("territory"),
    (q.get("q") ?? "").slice(0, 100),
    view === "over",
    view === "waiting" ? ctx.actor.subject : null,
  ];
  const condition = `${ORDER_ACCESS}
    and ($3::text is null or o.status = $3) and ($4::text is null or o.salesperson_profile_id::text = $4 or o.salesperson_subject = $4)
    and ($5::text is null or o.customer_code = $5) and ($6::text is null or lower(coalesce(o.channel_key,c.channel)) = lower($6))
    and ($7::text is null or o.territory_id::text = $7 or territory.code = $7)
    and ($8 = '' or strpos(lower(concat_ws(' ',o.order_number,c.name,c.code,p.name)),lower($8)) > 0)
    and (not $9::boolean or o.credit_status = 'over')
    and ($10::text is null or (o.created_by_subject is distinct from $10 and o.salesperson_subject <> $10))`;
  const dateExpr = `coalesce(o.service_date,(coalesce(o.offline_created_at,o.created_at) at time zone 'Asia/Manila')::date)`;
  const bound = [...params, ...filters];
  const [summary] = await ctx.db.unsafe(
    `select
    count(*) filter(where ${dateExpr} between $11::date and $12::date)::integer as count,
    count(*) filter(where ${dateExpr} between $11::date and $12::date and not o.amount_known)::integer as unknown,
    count(*) filter(where ${dateExpr} between $11::date and $12::date and not o.amount_known and o.status not in ('draft','rejected','voided'))::integer as sales_unknown,
    coalesce(sum(coalesce(o.total_centavos,(o.total*100)::bigint)) filter(where ${dateExpr} between $11::date and $12::date and o.status not in ('draft','rejected','voided')),0)::bigint as amount,
    coalesce(sum(coalesce(o.total_centavos,(o.total*100)::bigint)) filter(where ${dateExpr} between $13::date and $14::date and o.status not in ('draft','rejected','voided')),0)::bigint as prior,
    count(*) filter(where ${dateExpr} between $13::date and $14::date and not o.amount_known and o.status not in ('draft','rejected','voided'))::integer as prior_unknown,
    count(*) filter(where ${dateExpr} between $11::date and $12::date and o.status = 'pending_approval')::integer as waiting,
    count(*) filter(where ${dateExpr} between $11::date and $12::date and o.credit_status = 'over')::integer as over
    ${ORDER_FROM} where ${condition} and ${dateExpr} between $13::date and $12::date`,
    [...bound, from, to, priorFrom, priorTo],
  );
  const trend = await ctx.db.unsafe(
    `select ${dateExpr}::text as date,count(*)::integer as orders,
    case when bool_and(o.amount_known) then sum(coalesce(o.total_centavos,(o.total*100)::bigint)) end as amount
    ${ORDER_FROM} where ${condition} and ${dateExpr} between $11::date and $12::date and o.status not in ('draft','rejected','voided') group by 1 order by 1`,
    [...bound, from, to],
  );
  const fingerprint = sha256Hex(canonicalJson([...bound, from, to]));
  let cursorAt = null,
    cursorId = null;
  if (q.get("cursor")) {
    try {
      const c = JSON.parse(new TextDecoder().decode(unb64url(q.get("cursor"))));
      if (c.filter !== fingerprint || !Number.isFinite(Date.parse(c.at)))
        fail("Cursor no longer matches these filters");
      cursorAt = c.at;
      cursorId = uuid(c.id);
    } catch {
      fail("List cursor is invalid");
    }
  }
  const limit =
    q.get("format") === "csv"
      ? 10001
      : Math.min(100, Math.max(1, Number(q.get("limit") ?? 30)));
  if (!Number.isInteger(limit)) fail("Page size is invalid");
  const rows = await ctx.db.unsafe(
    `select o.*,c.name as customer_name,p.name as salesperson_name,territory.name as territory_name ${ORDER_FROM}
    where ${condition} and ${dateExpr} between $11::date and $12::date
    and $13::date <= $14::date and ($15::timestamptz is null or (o.created_at,o.id) < ($15::timestamptz,$16::uuid))
    order by o.created_at desc,o.id desc limit $17`,
    [...bound, from, to, priorFrom, priorTo, cursorAt, cursorId, limit + 1],
  );
  if (q.get("format") === "csv") {
    if (rows.length > 10000)
      throw new ApiError(
        "export_too_large",
        422,
        "Narrow the period before exporting more than 10,000 orders",
      );
    return csv([
      [
        "Order",
        "Date",
        "Customer",
        "Salesperson",
        "Channel",
        "Territory",
        "Stage",
        "Amount (centavos)",
        "Credit",
      ],
      ...rows.map((/** @type {any} */ r) => {
        const o = orderView(r);
        return [
          o.orderNumber,
          o.serviceDate,
          o.customerName,
          o.salespersonName,
          o.channel,
          o.territoryName,
          o.status,
          o.totalCentavos ?? "Unknown",
          o.creditStatus,
        ];
      }),
    ]);
  }
  const page = rows.slice(0, limit),
    last = page.at(-1);
  return {
    rows: page.map(orderView),
    next:
      rows.length > limit
        ? b64url(
            new TextEncoder().encode(
              JSON.stringify({
                at: new Date(last.created_at).toISOString(),
                id: last.id,
                filter: fingerprint,
              }),
            ),
          )
        : null,
    summary: {
      count: Number(summary.count),
      totalCentavos: Number(summary.sales_unknown)
        ? null
        : Number(summary.amount),
      priorCentavos: Number(summary.prior_unknown)
        ? null
        : Number(summary.prior),
      waiting: Number(summary.waiting),
      overCredit: Number(summary.over),
      unpriced: Number(summary.unknown),
      targetCentavos: null,
    },
    trend: trend.map((/** @type {any} */ r) => ({
      date: r.date,
      orders: r.orders,
      totalCentavos: r.amount === null ? null : Number(r.amount),
    })),
    period: { from, to },
    compare: { from: priorFrom, to: priorTo },
  };
}
/** @param {any} ctx */
export async function detail(ctx) {
  const row = await accessibleOrder(
    ctx,
    ctx.url.searchParams.get("id") ?? ctx.params.id,
  );
  const lines =
    await ctx.db`select * from order_lines where order_id = ${row.id} and deleted_at is null order by ordinal nulls last,created_at,id`;
  const history =
    await ctx.db`select h.*,coalesce(p.name,'Former user') as name from order_history h left join profiles p on p.user_id::text = h.actor_subject or p.auth_subject = h.actor_subject where h.order_id = ${row.id} order by h.created_at,h.id`;
  return {
    ...orderView(row),
    lines: lines.map((/** @type {any} */ l) => ({
      productCode: l.product_code,
      description: l.description,
      quantity: Number(l.quantity),
      quantityBase: l.quantity_base === null ? null : Number(l.quantity_base),
      uom: l.uom,
      unitPriceCentavos:
        l.unit_price_centavos === null
          ? row.pricing_snapshot === null && row.amount_known
            ? Math.round(Number(l.unit_price) * 100)
            : null
          : Number(l.unit_price_centavos),
      lineTotalCentavos:
        l.line_total_centavos === null
          ? row.pricing_snapshot === null && row.amount_known
            ? Math.round(Number(l.line_total) * 100)
            : null
          : Number(l.line_total_centavos),
    })),
    pricing: row.pricing_snapshot,
    credit: {
      status: row.credit_status ?? "unknown",
      limit:
        row.credit_limit_centavos === null
          ? null
          : Number(row.credit_limit_centavos),
      exposure:
        row.credit_exposure_centavos === null
          ? null
          : Number(row.credit_exposure_centavos),
      definition:
        "Open captured orders only; SAP receivables are not connected.",
    },
    history: history.map((/** @type {any} */ h) => ({
      id: h.id,
      name: h.name,
      action: h.action,
      from: h.from_status,
      to: h.to_status,
      reason: h.reason,
      at: new Date(h.created_at).getTime(),
    })),
    canDecide:
      ctx.actor.capabilities.has("order.approve") &&
      row.status === "pending_approval" &&
      row.created_by_subject !== ctx.actor.subject &&
      row.salesperson_subject !== ctx.actor.subject &&
      row.salesperson_profile_id !== ctx.actor.profileId,
  };
}
/** @param {any} router */
export function installOrderRoutes(router) {
  router.get("/api/v1/orders/list", list);
  router.get("/api/v1/orders/filter-options", async (/** @type {any} */ c) => {
    const params = await scopeParams(c);
    const rows = await c.db.unsafe(
      `select distinct p.id as person_id,p.name as person_name,c.code as customer_code,c.name as customer_name,
      coalesce(o.channel_key,c.channel) as channel,territory.id as territory_id,territory.code as territory_code,territory.name as territory_name
      ${ORDER_FROM} where ${ORDER_ACCESS} limit 1001`,
      params,
    );
    if (rows.length > 1000)
      fail(
        "More than 1,000 filter combinations; use the owner scope drill-down first",
      );
    const unique = (/** @type {any[]} */ values) => [
      ...new Map(
        values.filter((x) => x.value).map((x) => [x.value, x]),
      ).values(),
    ];
    return {
      people: unique(
        rows.map((/** @type {any} */ x) => ({
          value: x.person_id,
          label: x.person_name,
        })),
      ),
      customers: unique(
        rows.map((/** @type {any} */ x) => ({
          value: x.customer_code,
          label: x.customer_name,
        })),
      ),
      territories: unique(
        rows.map((/** @type {any} */ x) => ({
          value: x.territory_code,
          label: x.territory_name,
        })),
      ),
      channels: unique(
        rows.map((/** @type {any} */ x) => ({
          value: x.channel,
          label: x.channel,
        })),
      ),
    };
  });
  router.get("/api/v1/orders/detail", detail);
  router.get("/api/v1/orders/workflows", async (/** @type {any} */ c) => {
    await requireCapability(c, "order.approve");
    c.url.searchParams.set("status", "pending_approval");
    return list(c);
  });
  router.post("/api/v1/orders/create", async (/** @type {any} */ c) => {
    const result = await command(
      c,
      "create",
      c.body,
      async (cc) => {
        await requireCapability(cc, "order.create");
      },
      async (cc) => {
        const row = await createOrder(cc, {
          clientRequestId: c.body.clientRequestId,
          customerCode: c.body.customerCode,
          outletId: c.body.outletId,
          lines: c.body.lines,
          status: c.body.status,
        });
        return {
          id: row.id,
          rows: [
            {
              id: row.id,
              org_unit_id: row.org_unit_id,
              service_date: row.service_date,
            },
          ],
        };
      },
    );
    await notify(c, result.rows);
    return { id: result.id };
  });
  for (const action of ["approve", "reject", "transition"])
    router.post(`/api/v1/orders/${action}`, async (/** @type {any} */ c) => {
      if (!c.body || typeof c.body !== "object" || Array.isArray(c.body))
        fail("Command body must be an object");
      const status =
        action === "approve"
          ? "approved"
          : action === "reject"
            ? "rejected"
            : text(c.body.status, "Stage", 32);
      const ids = c.body.ids ?? [c.body.id];
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 50 ||
        new Set(ids).size !== ids.length
      )
        fail("Choose 1–50 distinct orders");
      ids.forEach((/** @type {any} */ id) => uuid(id));
      ids.sort();
      const result = await command(
        c,
        action,
        c.body,
        async (cc) => {
          for (const id of ids) await accessibleOrder(cc, id);
          await requireCapability(
            cc,
            action !== "transition" ||
              ["approved", "rejected", "fulfilled"].includes(status)
              ? "order.approve"
              : status === "posted"
                ? "integration.manage"
                : "order.create",
          );
        },
        async (cc) => {
          const rows = [];
          for (const id of ids) {
            const row = await transition(cc, id, status, c.body.reason, c.body);
            rows.push({
              id: row.id,
              org_unit_id: row.org_unit_id,
              service_date: row.service_date,
            });
          }
          return { ids, rows };
        },
      );
      await notify(c, result.rows);
      return { ok: true, ids: result.ids };
    });
}
