import { fail, localDate, outletAt } from "./model.js";

/** F-203. SEAM(SAP): replace this adapter with SAP-lane open-item replica reads.
 * Office sample AR is labelled as such, never a ledger or a live SAP credit check.
 * @param {any} ctx @param {string} outletId @param {string} serviceDate */
export async function agendaAr(ctx, outletId, serviceDate) {
  const db = ctx.db;
  const [r] =
    await db`select r.* from admin_pack_records r join customers c on c.code=r.details->>'customerCode' join outlet_customer_links l on l.customer_id=c.id where l.outlet_id=${outletId} and l.deleted_at is null and c.deleted_at is null and l.effective_from<=${new Date(localDate(serviceDate))} and (l.effective_to is null or l.effective_to>${new Date(localDate(serviceDate))}) and r.kind='ar_balance' and r.source='sample' and r.org_unit_id=${ctx.actor.orgUnitId} and r.details->>'asOfDate'<=${serviceDate} order by r.details->>'asOfDate' desc,r.created_at desc,r.id desc limit 1`;
  if (!r)
    return {
      status: "unavailable",
      amountMinor: null,
      source: "SAP open items not connected",
      asOfDate: null,
    };
  const keys = [
    "currentMinor",
    "days1to30Minor",
    "days31to60Minor",
    "days61to90Minor",
    "over90Minor",
  ];
  const values = keys.map((k) => r.details[k]);
  if (values.some((n) => !Number.isSafeInteger(n) || n < 0))
    fail("Sample AR has an invalid amount");
  const amount = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(amount)) fail("AR amount exceeds supported bound");
  return {
    status: "sample",
    amountMinor: amount,
    source: "Sample office AR snapshot — not live SAP",
    asOfDate: r.details.asOfDate,
  };
}
/** F-203. SEAM(AVAILABILITY): existing effective direct assortment, until the
 * availability lane supplies resolved taxonomy/class MSL. Never infer omitted
 * checks as present, and never mix observations from a different assortment.
 * @param {any} ctx @param {string} outletId @param {string} serviceDate */
export async function agendaMsl(ctx, outletId, serviceDate) {
  const db = ctx.db,
    at = new Date(localDate(serviceDate));
  const [set] =
    await db`select * from outlet_assortments where outlet_id=${outletId} and deleted_at is null and effective_from<=${at} and (effective_to is null or effective_to>${at})`;
  if (!set)
    return {
      status: "needs_setup",
      source: "No applicable MSL supplied",
      version: null,
      asOfDate: null,
      gaps: [],
      unmeasured: [],
      requiredCount: null,
    };
  const required =
    await db`select p.id,p.code,p.name from outlet_assortment_products l join products p on p.id=l.product_id where l.outlet_assortment_id=${set.id} and l.deleted_at is null and p.deleted_at is null and p.active order by l.ordinal limit 501`;
  if (required.length > 500) fail("Agenda MSL exceeds 500 lines");
  const [audit] =
    await db`select a.id,a.service_date from merchandising_audits a where a.outlet_id=${outletId} and a.assortment_id=${set.id} and a.assignee_profile_id=${ctx.actor.profileId} and a.org_unit_id=${ctx.actor.orgUnitId} and a.service_date<${serviceDate}::date and a.deleted_at is null order by a.service_date desc,a.device_time desc,a.id desc limit 1`;
  const observations = audit
    ? await db`select product_id,status from merchandising_availability where audit_id=${audit.id} and deleted_at is null order by id limit 501`
    : [];
  if (observations.length > 500)
    fail("Agenda MSL observation exceeds 500 lines");
  const rows = required.map((/** @type {any} */ p) => ({
    productId: p.id,
    code: p.code,
    name: p.name,
    status:
      observations.find((/** @type {any} */ o) => o.product_id === p.id)
        ?.status ?? "unmeasured",
  }));
  return {
    status: required.length ? "known" : "needs_setup",
    source:
      "Effective outlet assortment; latest prior synced audit for this rep",
    version: set.id,
    asOfDate: audit
      ? audit.service_date instanceof Date
        ? audit.service_date.toISOString().slice(0, 10)
        : String(audit.service_date).slice(0, 10)
      : null,
    gaps: rows.filter((/** @type {any} */ r) =>
      ["out_of_stock", "not_carried"].includes(r.status),
    ),
    unmeasured: rows.filter(
      (/** @type {any} */ r) => r.status === "unmeasured",
    ),
    requiredCount: required.length,
  };
}
/** Authorized once per outlet/day; callers have already verified signed stops.
 * @param {any} ctx @param {any[]} planned */
export async function agendaForPlans(ctx, planned) {
  const values = new Map();
  for (const p of planned) {
    const date =
        p.service_date instanceof Date
          ? p.service_date.toISOString().slice(0, 10)
          : String(p.service_date).slice(0, 10),
      key = `${p.outlet_id}:${date}`;
    if (values.has(key)) continue;
    await outletAt(ctx, p.outlet_id, ctx.now, "visit.record");
    const [last] =
      await ctx.db`select service_date,outcome,reason_code from visit_executions where outlet_id=${p.outlet_id} and assignee_profile_id=${ctx.actor.profileId} and org_unit_id=${ctx.actor.orgUnitId} and service_date<${date}::date and state in ('checked-out','completed') and deleted_at is null order by service_date desc,ended_at desc,id desc limit 1`;
    values.set(key, {
      asOfDate: date,
      beat: p.approved_snapshot?.routeCode ?? null,
      planVersion: p.plan_version,
      objectives: p.required_objectives ?? [],
      lastVisit: last
        ? {
            date:
              last.service_date instanceof Date
                ? last.service_date.toISOString().slice(0, 10)
                : String(last.service_date).slice(0, 10),
            outcome: last.outcome ?? "completed",
          }
        : null,
      ar: await agendaAr(ctx, p.outlet_id, date),
      msl: await agendaMsl(ctx, p.outlet_id, date),
    });
  }
  return values;
}
