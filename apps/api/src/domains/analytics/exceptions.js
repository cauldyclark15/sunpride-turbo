import {
  readPeople,
  readVisits,
  visitSummary,
  readAvailability,
  readMoney,
  readStores,
} from "./data.js";
import { readVans } from "./stock-money.js";
import { readSales, status, ms, maxTime, sum, dateOf } from "./measures.js";
import { targetFor } from "./targets.js";
import { ApiError } from "../../core/errors.js";

export const KINDS = [
  "behind_target",
  "missed_stops",
  "not_started",
  "idle_agent",
  "location_issue",
  "van_unclosed",
  "cash_variance",
  "stock_variance",
  "oos_hotspot",
  "credit_breach",
  "order_approval",
  "mcp_approval",
  "talk_sheet_overdue",
  "per_diem_review",
  "new_store",
  "dormant_key_store",
];
/** @param {any} ctx @param {any} p @param {any} s @param {any} [prefetched] */
export async function exceptionsFor(ctx, p, s, prefetched = {}) {
  const db = ctx.db,
    ids = s.ids.length ? s.ids : [null];
  const [people, facts, sales, vans, availability, money, stores] =
    await Promise.all([
      prefetched.people ?? readPeople(db, s, p.channel),
      prefetched.facts ?? readVisits(db, p, s),
      prefetched.sales ?? readSales(db, p, s, "agent"),
      prefetched.vans ?? readVans(db, p, s),
      readAvailability(db, p, s),
      readMoney(db, p, s),
      readStores(db, s, p.channel),
    ]);
  /** @type {any[]} */ const items = [];
  const owner = (/** @type {any} */ person) =>
    person?.supervisor_profile_id
      ? {
          profileId: person.supervisor_profile_id,
          name: person.supervisor_name ?? "Supervisor",
        }
      : null;
  const personFor = (/** @type {string} */ id) =>
    people.find((/** @type {any} */ r) => r.id === id);
  const add = (
    /** @type {string} */ kind,
    /** @type {string} */ id,
    /** @type {string} */ severity,
    /** @type {string} */ title,
    /** @type {string} */ detail,
    /** @type {any} */ subject,
    /** @type {any} */ responsible,
    /** @type {number|null} */ dueAt,
    /** @type {number} */ openedAt,
    /** @type {any} */ evidence,
    /** @type {string} */ href,
  ) =>
    items.push({
      id: `${kind}:${id}`,
      kind,
      severity,
      title,
      detail,
      subject,
      owner: responsible,
      dueAt,
      openedAt,
      evidence,
      action: { label: "Review", href },
    });
  for (const person of people.filter(
    (/** @type {any} */ r) => r.role === "sales",
  )) {
    const own = {
      planned: facts.planned.filter(
        (/** @type {any} */ r) => r.assignee_profile_id === person.id,
      ),
      visits: facts.visits.filter(
        (/** @type {any} */ r) => r.assignee_profile_id === person.id,
      ),
      coaching: [],
    };
    const a = visitSummary(own),
      value =
        sales.rows.find((/** @type {any} */ r) => r.key === person.id)?.sales ??
        0,
      target = await targetFor(
        db,
        s,
        { ...p, to: p.today < p.to ? p.today : p.to },
        "agent",
        person.id,
      );
    const subject = { type: "agent", id: person.id, label: person.name };
    const plan = own.planned[0]?.plan_id,
      link = plan ? `/sales-force?plan=${plan}` : "/sales-force";
    if (status(value, target) === "behind")
      add(
        "behind_target",
        person.id,
        "high",
        `${person.name} is behind target`,
        "Sales are below 90% of the phased target.",
        subject,
        owner(person),
        null,
        ctx.now,
        { sales: value, target },
        link,
      );
    if (a.missed > 0)
      add(
        "missed_stops",
        person.id,
        "medium",
        `${person.name} has ${a.missed} stops to complete`,
        "Planned stops have no completed visit; late phone sync may explain the gap.",
        subject,
        owner(person),
        null,
        ctx.now,
        { planned: a.planned, visited: a.visited },
        link,
      );
    if (a.planned > 0 && !own.visits.length)
      add(
        "not_started",
        person.id,
        "medium",
        `${person.name} has not started`,
        "No execution has reached the server for the selected plan.",
        subject,
        owner(person),
        null,
        ctx.now,
        { planned: a.planned },
        link,
      );
    const last = maxTime(own.visits, "last_server_time");
    if (
      last !== null &&
      ctx.now - last > 3600_000 &&
      a.visited < a.planned &&
      dateOf(last) === p.today
    )
      add(
        "idle_agent",
        person.id,
        "medium",
        `${person.name} needs a check-in`,
        "No visit update for an hour while planned stops remain.",
        subject,
        owner(person),
        null,
        last,
        { lastSeenAt: last },
        `/supervision?tab=exceptions&visit=${own.visits[own.visits.length - 1].id}`,
      );
  }
  const visitIds = facts.visits.map((/** @type {any} */ r) => r.id);
  const locations =
    await db`select * from visit_location_evidence where visit_id in ${db(visitIds.length ? visitIds : [null])} and deleted_at is null and review_status='pending_review' and org_unit_id in ${db(ids)}`;
  for (const e of locations) {
    const v = facts.visits.find((/** @type {any} */ r) => r.id === e.visit_id);
    add(
      "location_issue",
      e.id,
      "medium",
      "Visit location needs review",
      e.result.replaceAll("_", " "),
      { type: "store", id: v.outlet_id, label: v.store_name },
      owner(personFor(v.assignee_profile_id)),
      null,
      ms(e.server_time) ?? ctx.now,
      { visitId: v.id, result: e.result },
      `/supervision?tab=exceptions&visit=${v.id}`,
    );
  }
  for (const v of vans) {
    const person = people.find((/** @type {any} */ r) => r.name === v.seller),
      subject = { type: "van", id: v.tripId, label: v.truck };
    if (v.status === "unclosed")
      add(
        "van_unclosed",
        v.tripId,
        "high",
        `${v.truck} is not settled`,
        "Review the trip before closing the day.",
        subject,
        owner(person),
        null,
        ctx.now,
        { status: v.status },
        `/van?trip=${v.tripId}`,
      );
    if (v.variance != null && v.variance !== 0)
      add(
        "cash_variance",
        v.tripId,
        "high",
        `${v.truck} cash does not balance`,
        "Remittance differs from recorded expected cash.",
        subject,
        owner(person),
        null,
        ctx.now,
        { variance: v.variance },
        `/van?trip=${v.tripId}`,
      );
    if (v.stockVarianceCases != null && v.stockVarianceCases !== 0)
      add(
        "stock_variance",
        v.tripId,
        "high",
        `${v.truck} stock does not balance`,
        "Trip stock reconciliation needs review.",
        subject,
        owner(person),
        null,
        ctx.now,
        { varianceCases: v.stockVarianceCases },
        `/van?trip=${v.tripId}`,
      );
  }
  // A blind counter must not learn expected-stock facts through a report, even aggregate signs.
  if (ctx.actor.capabilities.has("inventory.count.approve")) {
    const variances =
      await db`select l.id,l.product_id,l.variance_base,c.created_at,p.name,p.code from stock_count_lines l join stock_count_sessions c on c.id=l.session_id join inventory_locations loc on loc.id=c.location_id join products p on p.id=l.product_id
      where loc.org_unit_id in ${db(ids)} and c.status in ('submitted','reviewed') and c.created_by!=${ctx.actor.userId} and c.created_by!=${ctx.actor.subject} and l.counted_by is distinct from ${ctx.actor.userId} and l.counted_by is distinct from ${ctx.actor.subject} and l.variance_base!=0`;
    for (const v of variances)
      add(
        "stock_variance",
        v.id,
        "high",
        `${v.name} count variance`,
        "An independently counted balance needs approval.",
        { type: "sku", id: v.product_id, label: v.name },
        { profileId: ctx.actor.profileId, name: ctx.actor.name ?? "Approver" },
        null,
        ms(v.created_at) ?? ctx.now,
        { varianceBase: Number(v.variance_base) },
        `/inventory?product=${v.product_id}`,
      );
  }
  for (const a of availability.filter((/** @type {any} */ a) =>
    ["out_of_stock", "not_carried"].includes(a.status),
  )) {
    const store = stores.find((/** @type {any} */ o) => o.id === a.outlet_id);
    add(
      "oos_hotspot",
      a.id,
      "medium",
      `${store?.name ?? "Store"} has a shelf gap`,
      "A recorded audit found a required product missing.",
      { type: "sku", id: a.product_id, label: "Missing product" },
      null,
      null,
      ms(a.created_at) ?? ctx.now,
      { storeId: a.outlet_id, productId: a.product_id },
      `/inventory?product=${a.product_id}`,
    );
  }
  for (const r of money.rows.filter(
    (/** @type {any} */ r) => r.creditLimit > 0 && r.balance > r.creditLimit,
  )) {
    const store = stores.find(
      (/** @type {any} */ o) => o.customer_id === r.accountId,
    );
    add(
      "credit_breach",
      r.accountId,
      "high",
      `${r.name} is above credit limit`,
      "Recorded receivables exceed the configured credit limit.",
      { type: "store", id: store?.id ?? r.accountId, label: r.name },
      null,
      null,
      ctx.now,
      { balance: r.balance, creditLimit: r.creditLimit },
      `/admin?section=outlets&outlet=${store?.id ?? r.accountId}`,
    );
  }
  const pendingOrders =
    await db`select f.order_id,max(f.agent_name) as name,max(f.profile_id::text) as profile_id,min(f.created_at) as at,sum(f.sales_centavos) as amount,
    (select p.id from workflow_instances w join approvals a on a.workflow_id=w.id join profiles p on p.auth_subject=a.approver_subject or p.user_id::text=a.approver_subject where w.entity_id=f.order_id::text and a.decision='pending' order by a.created_at limit 1) as approver_id
    from analytics_sales_facts f where f.status='pending_approval' and f.agent_unit_id in ${db(ids)} and f.owner_unit_id in ${db(ids)} and (f.source_location_id is null or f.source_unit_id in ${db(ids)}) and (${s.ownProfileId}::uuid is null or f.profile_id=${s.ownProfileId}) and (${p.channel}::text is null or f.channel=${p.channel}) group by f.order_id order by at,f.order_id limit ${prefetched.topOnly ? 5 : 2147483647}`;
  for (const o of pendingOrders) {
    const approver = personFor(o.approver_id);
    add(
      "order_approval",
      o.order_id,
      "medium",
      "Order awaiting approval",
      `An order from ${o.name} is waiting.`,
      { type: "order", id: o.order_id, label: "Sales order" },
      approver
        ? { profileId: approver.id, name: approver.name }
        : owner(personFor(o.profile_id)),
      null,
      ms(o.at) ?? ctx.now,
      { amountCentavos: Number(o.amount) },
      `/workflows?order=${o.order_id}`,
    );
  }
  const plans =
    await db`select c.*,p.name from coverage_plans c join analytics_people p on p.id=c.assignee_profile_id where c.status='submitted' and c.deleted_at is null and c.org_unit_id in ${db(ids)} and p.current_unit_id in ${db(ids)} and (${s.ownProfileId}::uuid is null or p.id=${s.ownProfileId}) and (${p.channel}::text is null or p.channel_scope=${p.channel})`;
  for (const plan of plans) {
    const approver = personFor(plan.approver_profile_id);
    add(
      "mcp_approval",
      plan.id,
      "medium",
      `${plan.name} MCP awaiting approval`,
      "Review the signed monthly commitments.",
      { type: "agent", id: plan.assignee_profile_id, label: plan.name },
      approver
        ? { profileId: approver.id, name: approver.name }
        : owner(personFor(plan.assignee_profile_id)),
      null,
      ms(plan.submitted_at) ?? ctx.now,
      { month: plan.local_month, version: plan.version },
      `/sales-force?plan=${plan.id}`,
    );
  }
  const talks =
    await db`select i.*,s.owner_profile_id,s.org_unit_id from talk_sheet_items i join talk_sheets s on s.id=i.sheet_id join analytics_people p on p.id=s.owner_profile_id where i.status='overdue' and s.status='final' and s.org_unit_id in ${db(ids)} and p.current_unit_id in ${db(ids)} and (${s.ownProfileId}::uuid is null or p.id=${s.ownProfileId}) and (${p.channel}::text is null or p.channel_scope=${p.channel})`;
  for (const t of talks) {
    const person = personFor(t.owner_profile_id);
    add(
      "talk_sheet_overdue",
      t.id,
      "medium",
      "Talk Sheet action overdue",
      t.corrective_action,
      {
        type: "agent",
        id: t.owner_profile_id,
        label: person?.name ?? "Responsible person",
      },
      person ? { profileId: person.id, name: person.name } : null,
      null,
      ms(t.created_at) ?? ctx.now,
      { gap: t.gap, responsible: t.responsible, timeline: t.timeline },
      `/supervision?tab=talk-sheets&item=${t.id}`,
    );
  }
  const perDiems =
    await db`select v.* from per_diem_validations v join analytics_people p on p.id=v.profile_id where v.decision='returned' and v.org_unit_id in ${db(ids)} and p.current_unit_id in ${db(ids)} and v.period_from<=${p.to} and v.period_to>=${p.from} and (${s.ownProfileId}::uuid is null or p.id=${s.ownProfileId}) and (${p.channel}::text is null or p.channel_scope=${p.channel})`;
  for (const v of perDiems) {
    const person = personFor(v.profile_id),
      approver = personFor(v.decider_profile_id);
    add(
      "per_diem_review",
      v.id,
      "medium",
      `${person?.name ?? "Person"} per diem needs review`,
      "Reports or plan evidence need a supervisor decision; this is not payroll.",
      { type: "agent", id: v.profile_id, label: person?.name ?? "Person" },
      approver
        ? { profileId: approver.id, name: approver.name }
        : owner(person),
      null,
      ms(v.decided_at) ?? ctx.now,
      { invalidCalls: v.invalid_calls, notVisited: v.not_visited },
      `/supervision?tab=per-diem&person=${v.profile_id}`,
    );
  }
  const newStores =
    await db`select e.* from outlet_enrolments e join analytics_store_scope o on o.id=e.outlet_id where e.status='pending' and e.deleted_at is null and e.org_unit_id in ${db(ids)} and o.owner_unit_id in ${db(ids)} and (${p.channel}::text is null or o.channel=${p.channel}) and (${s.ownProfileId}::uuid is null or e.proposed_by_profile_id=${s.ownProfileId})`;
  for (const e of newStores) {
    const store = stores.find((/** @type {any} */ o) => o.id === e.outlet_id);
    add(
      "new_store",
      e.id,
      "low",
      `${store?.name ?? "New store"} awaits verification`,
      "Review the provisional store and its enrollment evidence.",
      {
        type: "store",
        id: e.outlet_id,
        label: store?.name ?? e.provisional_code,
      },
      owner(personFor(e.proposed_by_profile_id)),
      null,
      ms(e.proposed_at) ?? ctx.now,
      { enrolmentId: e.id },
      `/admin?section=outlets&outlet=${e.outlet_id}`,
    );
  }
  const storeSales = stores.some((/** @type {any} */ o) =>
    ["key", "A", "key_account"].includes(o.classification),
  )
    ? await readSales(db, p, s, "store")
    : { rows: [] };
  const dormant = stores.filter(
    (/** @type {any} */ o) =>
      ["key", "A", "key_account"].includes(o.classification) &&
      !storeSales.rows.some(
        (/** @type {any} */ r) => r.key === o.id && r.sales > 0,
      ),
  );
  for (const o of dormant) {
    const [last] =
      await db`select max(service_date) as d from analytics_sales_facts where store_id=${o.id} and service_date<${p.from} and agent_unit_id in ${db(ids)} and owner_unit_id in ${db(ids)} and (source_location_id is null or source_unit_id in ${db(ids)}) and (${s.ownProfileId}::uuid is null or profile_id=${s.ownProfileId})`;
    if (last.d)
      add(
        "dormant_key_store",
        o.id,
        "medium",
        `${o.name} has stopped buying`,
        "A historically buying key store has no sale in the period.",
        { type: "store", id: o.id, label: o.name },
        null,
        null,
        ctx.now,
        { lastBuyingDate: dateOf(last.d) },
        `/admin?section=outlets&outlet=${o.id}`,
      );
  }
  const rank = /** @type {Record<string,number>} */ ({
    high: 0,
    medium: 1,
    low: 2,
  });
  return items.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) ||
      a.openedAt - b.openedAt ||
      a.id.localeCompare(b.id),
  );
}
/** @param {any} ctx @param {any} p @param {any} s */
export async function exceptionsPage(ctx, p, s) {
  const items = await exceptionsFor(ctx, p, s),
    q = ctx.url.searchParams,
    kind = q.get("kind"),
    severity = q.get("severity"),
    owner = q.get("ownerProfileId"),
    cursor = q.get("cursor");
  if (
    (kind && !KINDS.includes(kind)) ||
    (severity && !["high", "medium", "low"].includes(severity))
  )
    throw new ApiError("invalid_filter", 400, "Unknown exception filter");
  const filtered = items.filter(
    (i) =>
      (!kind || i.kind === kind) &&
      (!severity || i.severity === severity) &&
      (!owner || i.owner?.profileId === owner),
  );
  const counts = Object.fromEntries(
    KINDS.map((k) => [k, filtered.filter((i) => i.kind === k).length]),
  );
  const i = cursor ? filtered.findIndex((r) => r.id === cursor) + 1 : 0;
  if (cursor && i === 0)
    throw new ApiError("invalid_cursor", 400, "Restart this exception list");
  return {
    counts,
    items: filtered.slice(i, i + 50),
    next: filtered.length > i + 50 ? filtered[i + 49].id : null,
  };
}
