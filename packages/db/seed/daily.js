#!/usr/bin/env bun
import { createDb, tx } from "../src/client.js";
import { seedDistributors } from "./distributors.js";
import { seedFiscal } from "./fiscal.js";
import { company } from "./company.js";
import { seedSpecMasters } from "./spec-masters.js";
import { execution } from "./execution.js";
import { vans } from "./vans.js";
import { seedVanOps } from "./vanops.js";
import { management } from "./management.js";
import { ensureCallflowSamples } from "./callflow.js";
import { seedTpm } from "./tpm.js";
import { ensureIntegrityFleet } from "./integrity-fleet.js";
import { seedAvailability } from "./availability.js";
import { seedModernTrade } from "./modern-trade.js";
import { extendTowerSamples } from "./tower.js";
import {
  BATCH,
  Dataset,
  at,
  ident,
  insertRows,
  nextMonth,
  persist,
  plusDays,
  rowId,
  todayManila,
  weekday,
} from "./store.js";

/** @typedef {import('../src/client.js').Db} Db */
/** @typedef {import('./store.js').Row} Row */
const serviceDate = (/** @type {any} */ value) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
const STOCK_TABLES = [
  "inventory_movements",
  "inventory_movement_lines",
  "inventory_allocations",
  "inventory_ledger_entries",
  "inventory_commands",
  "inventory_balances",
  "inventory_lot_balances",
  "audit_logs",
  "integration_events",
  "integration_resolution_events",
];

/** Compress the history's noon snapshot into elapsed Manila time, without crossing
 * midnight or changing historical instants. @param {string} date @param {number} instant @param {number} [now] */
export function demoInstant(date, instant, now = Date.now()) {
  const start = at(date),
    noon = at(date, 12 * 60);
  if (instant < start || instant > noon || now >= noon) return instant;
  const scale = Math.max(0, now - start - 1000) / (noon - start);
  return Math.trunc(start + (instant - start) * scale);
}

/** A day has its own immutable identities, including plans, pings and exceptions. */
class DailyDataset extends Dataset {
  /** @param {string} table @param {string} key @param {Record<string,any>} values @param {string|number} [time] */
  add(table, key, values, time = this.epoch) {
    return super.add(table, `daily-${this.anchorDate}-${key}`, values, time);
  }
}

/** Only return rows explicitly owned by this sample batch. @param {Db} db @param {string} table @returns {Promise<Row[]>} */
async function owned(db, table) {
  return db.unsafe(
    `select r.* from ${ident(table)} r join sample_data_rows m on m.table_name=$1 and m.row_id=r.id::text and m.batch=$2`,
    [table, BATCH],
  );
}

/** Hydrate templates from persisted sample masters; never regenerate identities or credentials.
 * @param {Db} db @param {string} date */
async function context(db, date) {
  const template = new Dataset(date, 1);
  const c = company(template, []);
  const profiles = await owned(db, "profiles");
  const byId = new Map(profiles.map((p) => [p.id, p]));
  for (const [key, p] of Object.entries(c.people))
    c.people[key] = byId.get(p.id) ?? p;
  c.agents = c.agents
    .map((a) => ({ ...a, ...byId.get(a.id) }))
    .filter((a) => byId.has(a.id) && a.status === "active" && !a.deleted_at);
  const known = new Set(c.agents.map((a) => a.id));
  for (const person of profiles.filter(
    (p) =>
      p.role === "sales" &&
      p.status === "active" &&
      !p.deleted_at &&
      !known.has(p.id),
  )) {
    const source = c.agents.find((a) => a.position_id === person.position_id);
    if (!source) continue;
    const index = Math.max(...c.agents.map((a) => a.index)) + 1;
    c.agents.push({ ...source, ...person, index });
    c.routes[index] = c.routes[source.index];
  }
  const assignments =
    await db`select * from employee_assignments where deleted_at is null and effective_from<=${new Date(at(date, 12 * 60))} and (effective_to is null or effective_to>${new Date(at(date, 12 * 60))})`;
  c.agents = c.agents.filter((a) =>
    assignments.some(
      (/** @type {any} */ r) =>
        r.profile_id === a.id && r.org_unit_id === a.org_unit_id,
    ),
  );
  c.agents = c.agents.map((a) => ({
    ...a,
    assignmentId: assignments.find(
      (/** @type {any} */ r) =>
        r.profile_id === a.id && r.org_unit_id === a.org_unit_id,
    )?.id,
  }));
  const products = new Map(
    (await owned(db, "products"))
      .filter((p) => !p.deleted_at && p.active !== false)
      .map((p) => [p.id, p]),
  );
  c.products = c.products
    .filter((p) => products.has(p.id))
    .map((p) => ({ ...p, ...products.get(p.id) }));
  // Product indices belong to the generator's array, not a filtered historical catalog.
  c.products.forEach((p, i) => {
    p.index = i;
  });
  const stores = new Map(
    (await owned(db, "outlets"))
      .filter((s) => !s.deleted_at && s.status === "active")
      .map((s) => [s.id, s]),
  );
  const customers = new Map(
    (await owned(db, "customers"))
      .filter((s) => !s.deleted_at && s.active)
      .map((s) => [s.id, s]),
  );
  c.stores = c.stores
    .filter((s) => stores.has(s.id) && customers.has(s.customer.id))
    .map((s) => ({
      ...s,
      ...stores.get(s.id),
      customer: /** @type {Row} */ (customers.get(s.customer.id)),
    }));
  const routes =
    await db`select rs.profile_id,a.outlet_id from route_salespeople rs join outlet_assignments a on a.route_id=rs.route_id join territory_ownerships o on o.territory_id=a.territory_id where rs.deleted_at is null and a.deleted_at is null and o.deleted_at is null and rs.effective_from<=${new Date(at(date, 12 * 60))} and (rs.effective_to is null or rs.effective_to>${new Date(at(date, 12 * 60))}) and a.effective_from<=${new Date(at(date, 12 * 60))} and (a.effective_to is null or a.effective_to>${new Date(at(date, 12 * 60))}) and o.effective_from<=${new Date(at(date, 12 * 60))} and (o.effective_to is null or o.effective_to>${new Date(at(date, 12 * 60))})`;
  /** @type {Map<string,Set<string>>} */ const routeStops = new Map();
  for (const a of c.agents) {
    const stops = new Set(
      routes
        .filter((/** @type {any} */ r) => r.profile_id === a.id)
        .map((/** @type {any} */ r) => String(r.outlet_id)),
    );
    routeStops.set(a.id, stops);
    a.dailyCalls = Math.min(
      a.dailyCalls,
      c.stores.filter(
        (s) =>
          stops.has(s.id) &&
          (a.positionCode === "KAS"
            ? ["kas", "supermarket"].includes(s.channel)
            : a.positionCode.startsWith("PMOT")
              ? ["gt", "pmot"].includes(s.channel)
              : true),
      ).length,
    );
  }
  const locations = await owned(db, "inventory_locations");
  const depot = locations.find(
    (l) =>
      l.id === rowId("inventory_locations", "depot") &&
      l.active &&
      !l.deleted_at,
  );
  if (!depot || !c.products.length || !c.agents.length)
    throw new Error("Demo active sample masters are missing");
  const lots = await owned(db, "inventory_lots");
  return { c, routeStops, depot, locations, lots };
}

/** Capture production-created UUIDs without adopting existing rows. The marker binds the
 * actual UUID (or feed sequence) and its table; reset validates both before deleting.
 * @param {Db} db @param {string} table @param {string} value */
async function markNative(db, table, value) {
  const key = `${table}:daily-native:${value}`;
  await db`insert into sample_data_rows(id,batch,table_name,row_id,key) values(${rowId("sample_data_rows", key)},${BATCH},${table},${value},${key}) on conflict(batch,key) do nothing`;
}

/** No production balance owned by a tester may be updated by the daily sample posting.
 * @param {Db} db @param {string[]} locations @param {string[]} products */
async function guardBalances(db, locations, products) {
  for (const table of ["inventory_balances", "inventory_lot_balances"]) {
    const rows = await db.unsafe(
      `select r.id from ${ident(table)} r where r.location_id=any($1::uuid[]) and r.product_id=any($2::uuid[]) and not exists(select 1 from sample_data_rows m where m.batch=$3 and m.table_name=$4 and m.row_id=r.id::text) limit 1`,
      [`{${locations.join(",")}}`, `{${products.join(",")}}`, BATCH, table],
    );
    if (rows.length) throw new Error("Demo refused to change non-sample stock");
  }
}

/** Close only unmodified, wholly sample-owned past trips. Any tester child, operation,
 * receipt or stock movement keeps the entire trip out of the automation.
 * @param {Db} db @param {DailyDataset} d @param {any} stock @param {any} ctx */
async function closePastTrips(db, d, stock, ctx) {
  const trips = (await owned(db, "van_trips")).filter(
    (t) =>
      serviceDate(t.service_date) < d.anchorDate &&
      !["closed", "cancelled"].includes(t.status),
  );
  let closed = 0;
  for (const trip of trips) {
    if (!(await pristineTrip(db, trip))) continue;
    const [session] = trip.route_session_id
      ? await db`select * from truck_route_sessions where id=${trip.route_session_id}`
      : [];
    if (
      session &&
      !(await owned(db, "truck_route_sessions")).some(
        (s) => s.id === session.id,
      )
    )
      continue;
    const events =
      await db`select product_id,stock_status,sum(delta_base)::text qty from van_stock_events where trip_id=${trip.id} group by 1,2 having sum(delta_base)>0`;
    // Old seed's extra load predates van_stock_events. The canonical ledger is authoritative.
    const balances =
      await db`select b.product_id,b.lot_id,b.stock_status,b.available_base::text qty from inventory_lot_balances b where b.location_id=${trip.truck_location_id} and b.available_base>0`;
    const time = stock.time(at(d.anchorDate, 5 * 60));
    const [priorCount] =
      await db`select * from van_stock_counts where trip_id=${trip.id}`;
    const count =
      priorCount ??
      d.add(
        "van_stock_counts",
        `close-${trip.id}`,
        {
          trip_id: trip.id,
          count_code: `SMP-DAILY-${trip.id}`,
          variance_lines: 0,
          short_base: 0,
          over_base: 0,
          facts: { source: "sample" },
        },
        time,
      );
    for (const b of events)
      d.add(
        "van_stock_count_lines",
        `close-${trip.id}-${b.product_id}-${b.stock_status}`,
        {
          count_id: count.id,
          product_id: b.product_id,
          stock_status: b.stock_status,
          expected_base: Number(b.qty),
          counted_base: Number(b.qty),
          variance_base: 0,
          value_centavos: 0,
          facts: { source: "sample" },
        },
        time,
      );
    if (balances.length)
      await stock.post({
        key: `close-${trip.id}`,
        kind: "van_unload",
        sourceId: trip.id,
        time,
        lines: balances.map((/** @type {any} */ b) => ({
          productId: b.product_id,
          fromLocationId: trip.truck_location_id,
          toLocationId: trip.source_location_id,
          quantityBase: Number(b.qty),
          uom: "PC",
          lotId: b.lot_id,
          stockStatus: b.stock_status,
        })),
      });
    for (const b of events)
      d.add(
        "van_stock_events",
        `close-${trip.id}-${b.product_id}-${b.stock_status}`,
        {
          trip_id: trip.id,
          source_id: count.id,
          kind: "unload",
          product_id: b.product_id,
          stock_status: b.stock_status,
          delta_base: -Number(b.qty),
          facts: { source: "sample" },
        },
        time,
      );
    const [cash] =
      await db`select coalesce(sum(amount_centavos),0)::text amount from van_payments where trip_id=${trip.id}`;
    const prior =
      await db`select * from van_cash_counts where trip_id=${trip.id} order by created_at desc limit 1`;
    const cashCount =
      prior[0] ??
      d.add(
        "van_cash_counts",
        `close-${trip.id}`,
        {
          trip_id: trip.id,
          expected_centavos: Number(cash.amount),
          declared_centavos: Number(cash.amount),
          variance_centavos: 0,
          facts: { source: "sample" },
        },
        time,
      );
    const [remitted] =
      await db`select coalesce(sum(amount_centavos),0)::text amount from van_cash_remittances where trip_id=${trip.id}`;
    const amount = Math.max(
      0,
      Number(cashCount.declared_centavos) - Number(remitted.amount),
    );
    if (amount > 0)
      d.add(
        "van_cash_remittances",
        `close-${trip.id}`,
        {
          trip_id: trip.id,
          count_id: cashCount.id,
          amount_centavos: amount,
          received_by: ctx.c.people.approver.id,
          received_by_name: ctx.c.people.approver.name,
          reference: `Sample daily settlement ${d.anchorDate}`,
        },
        time,
      );
    await db`update van_trips set status='closed',closed_at=${new Date(time)} where id=${trip.id}`;
    if (session)
      await db`update truck_route_sessions set status='closed',closed_at=${new Date(time)} where id=${session.id}`;
    d.event(
      "van_settlement",
      `close-${trip.id}`,
      {
        tripId: trip.id,
        serviceDate: serviceDate(trip.service_date),
        status: "settled",
        cashExpectedMinor: Number(cash.amount),
        cashRemittedMinor: Number(cashCount.declared_centavos),
        cashVarianceMinor: Number(cashCount.variance_centavos),
      },
      time,
    );
    closed++;
  }
  return closed;
}

/** @param {Db} db @param {Row} trip */
async function pristineTrip(db, trip) {
  for (const [table, column] of [
    ["van_sales", "trip_id"],
    ["van_payments", "trip_id"],
    ["van_stock_events", "trip_id"],
    ["van_cash_counts", "trip_id"],
    ["van_cash_remittances", "trip_id"],
    ["van_stock_counts", "trip_id"],
    ["van_trip_loads", "trip_id"],
    ["van_operations", "entity_id"],
    ["van_damage_records", "trip_id"],
    ["orders", "route_session_id"],
  ]) {
    const value =
      column === "route_session_id" ? trip.route_session_id : trip.id;
    if (!value) continue;
    const rows = await db.unsafe(
      `select 1 from ${ident(table)} r where r.${ident(column)}=$1 and not exists(select 1 from sample_data_rows m where m.batch=$2 and m.table_name=$3 and m.row_id=r.id::text) limit 1`,
      [value, BATCH, table],
    );
    if (rows.length) return false;
  }
  const [movement] =
    await db`select 1 from inventory_ledger_entries l where l.location_id=${trip.truck_location_id} and not exists(select 1 from sample_data_rows m where m.batch=${BATCH} and m.table_name='inventory_ledger_entries' and m.row_id=l.id::text) limit 1`;
  return !movement;
}

/** Retire yesterday's synthetic open calls, unless any real evidence was added.
 * @param {Db} db @param {DailyDataset} d */
async function closePastCalls(db, d) {
  const calls = (await owned(db, "visit_executions")).filter(
    (v) =>
      serviceDate(v.service_date) < d.anchorDate &&
      ["arrived", "checked-in", "in-progress"].includes(v.state),
  );
  for (const v of calls) {
    let real = false;
    for (const table of [
      "visit_activities",
      "visit_location_evidence",
      "field_collections",
      "field_order_pricings",
    ]) {
      const rows = await db.unsafe(
        `select 1 from ${ident(table)} r where r.visit_id=$1 and not exists(select 1 from sample_data_rows m where m.batch=$2 and m.table_name=$3 and m.row_id=r.id::text) limit 1`,
        [v.id, BATCH, table],
      );
      if (rows.length) {
        real = true;
        break;
      }
    }
    const [event] =
      await db`select 1 from execution_events r where r.entity_id=${v.id} and r.entity_type='visit' and not exists(select 1 from sample_data_rows m where m.batch=${BATCH} and m.table_name='execution_events' and m.row_id=r.id::text) limit 1`;
    if (real || event) continue;
    const date = serviceDate(v.service_date),
      end = at(date, 17 * 60);
    await db`update visit_executions set state='completed',outcome='completed',productivity='nonproductive',reason_code='sample_day_close',checked_out_at=${new Date(end)},ended_at=${new Date(end)},completed_at=${new Date(end)},last_server_time=${new Date(end)},call_duration_ms=${Math.max(0, end - Number(new Date(v.checked_in_at ?? v.started_at)))} where id=${v.id}`;
    d.add(
      "visit_activities",
      `close-${v.id}`,
      {
        organization_id: v.organization_id,
        org_unit_id: v.org_unit_id,
        visit_id: v.id,
        assignee_profile_id: v.assignee_profile_id,
        outlet_id: v.outlet_id,
        activity_kind: "note",
        activity: {
          kind: "note",
          source: "sample",
          text: "Sample day ended; no qualifying productive activity recorded.",
        },
        device_time: new Date(end).toISOString(),
        server_time: new Date(end).toISOString(),
      },
      end,
    );
    d.add(
      "execution_events",
      `close-${v.id}`,
      {
        organization_id: v.organization_id,
        org_unit_id: v.org_unit_id,
        entity_type: "visit",
        entity_id: v.id,
        kind: "check_out",
        actor_subject: "system:sample",
        actor_role: "admin",
        actor_org_unit_id: v.org_unit_id,
        source: "system",
        operation_key: `sample:daily:close:${v.id}`,
        occurred_at: new Date(end).toISOString(),
        server_at: new Date(end).toISOString(),
        summary_reason_code: "sample_day_close",
        schema_version: 1,
      },
      end,
    );
  }
}

/** Day-sized approved revisions preserve old signatures and all historical work.
 * @param {Db} db @param {DailyDataset} d @param {string} date @param {URL} api */
async function finalizePlans(db, d, date, api) {
  const { digest } = await import(
    new URL("domains/coverage/workflow.js", api).href
  );
  const { dto, civil } = await import(
    new URL("domains/coverage/model.js", api).href
  );
  const { verifySignature } = await import(
    new URL("domains/coverage/activation.js", api).href
  );
  const empty = new Set(
    d
      .rows("coverage_plans")
      .filter(
        (p) => !d.rows("coverage_plan_slots").some((s) => s.plan_id === p.id),
      )
      .map((p) => p.id),
  );
  for (const [table, rows] of d.tables)
    d.tables.set(
      table,
      rows.filter(
        (r) =>
          !empty.has(
            r.plan_id ??
              r.coverage_plan_id ??
              (table === "coverage_plans" ? r.id : null),
          ),
      ),
    );
  const retained = new Set([...d.tables.values()].flat().map((r) => r.id));
  d.markers = d.markers.filter((m) => retained.has(m.row_id));
  for (const plan of d.rows("coverage_plans")) {
    const [version] =
      await db`select coalesce(max(version),0)::int n from coverage_plans where assignee_profile_id=${plan.assignee_profile_id} and local_month=${plan.local_month}`;
    plan.version = version.n + 1;
    plan.effective_from = plan.requested_from = d.epoch;
    plan.effective_to = plan.requested_to = new Date(
      at(plusDays(date, 1)),
    ).toISOString();
    const predecessors =
      await db`select p.* from coverage_plans p join sample_data_rows m on m.batch=${BATCH} and m.table_name='coverage_plans' and m.row_id=p.id::text where p.assignee_profile_id=${plan.assignee_profile_id} and p.status in ('approved','active') and p.effective_from<${new Date(at(plusDays(date, 1)))} and coalesce(p.active_through,p.effective_to)>${new Date(at(date))} order by p.version desc`;
    plan.based_on_plan_id = predecessors[0]?.id ?? null;
    plan.revision_reason = "Sample company daily continuation";
    for (const prior of predecessors) {
      await db`update coverage_plans set status='superseded',superseded_at=${new Date()},active_through=${new Date(at(date))} where id=${prior.id}`;
      d.add(
        "coverage_audit_events",
        `superseded-${prior.id}`,
        {
          plan_id: prior.id,
          assignee_profile_id: prior.assignee_profile_id,
          org_unit_id: prior.org_unit_id,
          local_month: prior.local_month,
          actor_subject: "system:sample",
          action: "plan.superseded",
          reason: "Sample company daily continuation",
          affected_entity: "coverage_plans",
          plan_version: prior.version,
          before: { status: prior.status },
          after: { status: "superseded", source: "sample" },
        },
        Date.now(),
      );
    }
    const assignments = d
      .rows("coverage_assignments")
      .filter((a) => a.plan_id === plan.id);
    for (const a of assignments) {
      a.effective_from = plan.effective_from;
      a.effective_to = plan.effective_to;
    }
    const slots = d
      .rows("coverage_plan_slots")
      .filter((s) => s.plan_id === plan.id);
    const stops = new Set(slots.map((s) => s.outlet_id));
    d.tables.set(
      "coverage_plan_outlets",
      d
        .rows("coverage_plan_outlets")
        .filter((o) => o.plan_id !== plan.id || stops.has(o.outlet_id)),
    );
    const outlets = d
      .rows("coverage_plan_outlets")
      .filter((o) => o.plan_id === plan.id);
    for (const o of outlets) o.custom_local_dates = [date];
    for (const p of [
      ...d.rows("planned_visits"),
      ...d.rows("visit_executions"),
    ].filter((p) => p.plan_id === plan.id))
      p.plan_version = plan.version;
    plan.signed_content = {
      source: "sample",
      plan: {
        id: plan.id,
        version: plan.version,
        assignee: plan.assignee_profile_id,
        month: plan.local_month,
        organization: plan.organization_id,
        unit: plan.org_unit_id,
        effectiveFrom: Date.parse(plan.effective_from),
        effectiveTo: Date.parse(plan.effective_to),
        requestedFrom: Date.parse(plan.requested_from),
        requestedTo: Date.parse(plan.requested_to),
        basedOn: plan.based_on_plan_id,
        reason: plan.revision_reason,
        preparedBy: plan.prepared_by,
      },
      assignments: dto(assignments),
      outlets: dto(outlets),
      slots: slots.map((s) => civil(s)),
    };
    plan.content_hash = digest(plan.signed_content);
    plan.approval_signature = `${plan.id}:${plan.version}:${plan.approved_by}:${Date.parse(plan.approved_at)}:${plan.content_hash}`;
    verifySignature(plan);
    for (const a of d
      .rows("coverage_audit_events")
      .filter((a) => a.plan_id === plan.id)) {
      a.plan_version = plan.version;
      a.approval_signature_ref = plan.approval_signature;
      a.after = { source: "sample", slots: slots.length };
    }
  }
  const ids = new Set([...d.tables.values()].flat().map((r) => r.id));
  d.markers = d.markers.filter((m) => ids.has(m.row_id));
}

/** Add a missing day, all-or-nothing, under the same lock used by seed/trial/reset.
 * @param {Db} db @param {string} date @param {string} originalStart */
async function advanceDay(db, date, originalStart) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4310090)`;
    const [done] =
      await t`select 1 from sample_data_rows where batch=${BATCH} and key=${`audit_logs:daily-${date}-manifest`}`;
    if (done) {
      await extendTowerSamples(t, date);
      return { date, duplicate: true };
    }
    const api = new URL("../../../apps/api/src/", import.meta.url);
    const { ORG_LOCK } = await import(
      new URL("domains/org/identity.js", api).href
    );
    await t`select pg_advisory_xact_lock(${ORG_LOCK})`;
    // Serialize against field calls, order creation and van uploads while checking tester stops.
    for (const table of [
      "visit_executions",
      "planned_visits",
      "orders",
      "van_trips",
      "van_operations",
    ])
      await t.unsafe(`lock table ${ident(table)} in share row exclusive mode`);
    const ctx = await context(t, date),
      { c, routeStops, depot } = ctx;
    await ensureIntegrityFleet(t, date, c);
    const d = new DailyDataset(date, 1);
    const { postMovement } = await import(
      new URL("domains/inventory/posting.js", api).href
    );
    const { setHooks } = await import(new URL("core/hooks.js", api).href);
    const { identityHooks } = await import(
      new URL("domains/org/identity.js", api).href
    );
    const { actorFor } = await import(new URL("core/context.js", api).href);
    if (!(await actorFor(t, c.people.admin.user_id)))
      setHooks(identityHooks({}));
    const actor = {
      profileId: c.people.admin.id,
      userId: c.people.admin.user_id,
    };
    /** @type {Map<string,string>} */ const movementIds = new Map();
    /** @type {any[]} */ const pending = [];
    const lots = c.products.map((p) =>
      ctx.lots.find(
        (l) =>
          l.product_id === p.id &&
          l.quality_status === "released" &&
          Date.parse(l.expires_at) > Math.max(Date.now(), at(date)) + 86400000,
      ),
    );
    // New dated lots avoid changing expiry dates or manufacturing facts on old lots.
    for (const [i, p] of c.products.entries())
      if (!lots[i])
        lots[i] = d.add("inventory_lots", p.code, {
          organization_id: "sunpride",
          product_id: p.id,
          lot_number: `SMP-DAILY-${date}-${i}`,
          normalized_lot_number: `SMP-DAILY-${date}-${i}`,
          source_type: "sample",
          received_at: d.epoch,
          expires_at: new Date(at(plusDays(date, 365))).toISOString(),
          quality_status: "released",
          unit_cost_minor: p.cost,
        });
    const snapshotNow = Date.now();
    const stock = {
      time: (/** @type {number} */ instant) =>
        demoInstant(date, instant, snapshotNow),
      locations: [depot],
      lots,
      movement(/** @type {any} */ e) {
        pending.push(e);
        return rowId("inventory_movements", `daily-${date}-${e.key}`);
      },
      routeOrder(/** @type {string} */ id, /** @type {number} */ location) {
        const e = pending.find((e) => e.sourceId === id);
        if (e) {
          e.kind = "pos_sale";
          for (const l of e.lines) l.from = location;
        }
      },
      finish() {},
      async post(/** @type {any} */ e) {
        await guardBalances(
          t,
          [
            ...new Set(
              e.lines
                .flatMap((/** @type {any} */ l) => [
                  l.fromLocationId,
                  l.toLocationId,
                ])
                .filter(Boolean),
            ),
          ],
          e.lines.map((/** @type {any} */ l) => l.productId),
        );
        const result = await postMovement(t, {
          kind: e.kind,
          sourceType: "sample",
          sourceId: e.sourceId,
          idempotencyKey: `sample:daily:${date}:${e.key}`,
          occurredAt: Math.trunc(e.time),
          actor,
          organizationId: "sunpride",
          lines: e.lines,
          note: "Invented demo-company daily activity",
        });
        if (result.duplicate)
          throw new Error(
            "Demo daily posting key already exists without its day manifest",
          );
        await t`update integration_events set status='dead_letter',last_error='Invented demo data: never transmit to SAP',next_attempt_at=null where movement_id=${result.movementId}`;
        movementIds.set(
          rowId("inventory_movements", `daily-${date}-${e.key}`),
          result.movementId,
        );
        for (const table of ["inventory_balances", "inventory_lot_balances"]) {
          const fresh = await t.unsafe(
            `select r.id from ${ident(table)} r where r.xmin=pg_current_xact_id()::text::xid and not exists(select 1 from sample_data_rows m where m.table_name=$1 and m.row_id=r.id::text)`,
            [table],
          );
          for (const r of fresh) await markNative(t, table, String(r.id));
        }
        return result.movementId;
      },
    };
    // Persist only new lots before calling the production writer.
    if (d.rows("inventory_lots").length) {
      await insertRows(t, "inventory_lots", d.rows("inventory_lots"));
      await insertRows(t, "sample_data_rows", d.markers);
      d.tables.clear();
      d.markers = [];
    }
    const closed = await closePastTrips(t, d, stock, ctx);
    await closePastCalls(t, d);
    const alreadyTimed = new Set(
      [...d.tables.values()].flat().map((r) => r.id),
    );
    const existing =
      await t`select assignee_profile_id,outlet_id from planned_visits where service_date=${date} and deleted_at is null union select assignee_profile_id,outlet_id from visit_executions where service_date=${date} and deleted_at is null union select salesperson_profile_id,outlet_id from orders where service_date=${date} and deleted_at is null`;
    const existingPlans =
      await t`select distinct assignee_profile_id from planned_visits where service_date=${date} and deleted_at is null and status='planned'`;
    const foreignPlans =
      await t`select distinct p.assignee_profile_id from coverage_plans p where p.status in ('approved','active') and p.deleted_at is null and p.effective_from<${new Date(at(plusDays(date, 1)))} and coalesce(p.active_through,p.effective_to)>${new Date(at(date))} and not exists(select 1 from sample_data_rows m where m.batch=${BATCH} and m.table_name='coverage_plans' and m.row_id=p.id::text)`;
    for (const a of c.agents)
      if (
        existingPlans.some(
          (/** @type {any} */ p) => p.assignee_profile_id === a.id,
        ) ||
        foreignPlans.some(
          (/** @type {any} */ p) => p.assignee_profile_id === a.id,
        )
      )
        routeStops.set(a.id, new Set());
    const blocked = new Set(
      existing.map(
        (/** @type {any} */ r) => `${r.assignee_profile_id}:${r.outlet_id}`,
      ),
    );
    // A real call at any stop means that person is testing today. Leave their whole day alone.
    const testers =
      await t`select distinct v.assignee_profile_id from visit_executions v where v.service_date=${date} and not exists(select 1 from sample_data_rows m where m.batch=${BATCH} and m.table_name='visit_executions' and m.row_id=v.id::text)`;
    for (const a of c.agents)
      if (
        testers.some((/** @type {any} */ r) => r.assignee_profile_id === a.id)
      )
        routeStops.set(a.id, new Set());
    const historical = date < todayManila();
    const e = execution(d, c, /** @type {any} */ (stock), {
      daily: true,
      historical,
      blocked,
      routeStops,
      dayOffset: Math.round((at(date) - at(originalStart)) / 86400000),
    });
    // Only unused owned trucks get synthetic work; tester trips are never closed or duplicated.
    const vehicles = await owned(t, "vehicles");
    /** @type {Row[]} */ const selected = [];
    /** @type {typeof c.agents} */ const sellers = [];
    for (const vehicle of vehicles) {
      if (vehicle.status !== "active" || vehicle.deleted_at) continue;
      const [prior] =
        await t`select * from van_trips where vehicle_id=${vehicle.id} and service_date<=${date} and deleted_at is null order by service_date desc,created_at desc limit 1`;
      if (
        !prior ||
        serviceDate(prior.service_date) >= date ||
        !["closed", "cancelled"].includes(prior.status)
      )
        continue;
      const seller = c.agents.find(
        (a) => a.id === prior.salesperson_profile_id,
      );
      if (seller) {
        const [busy] =
          await t`select 1 from van_trips where salesperson_profile_id=${seller.id} and service_date=${date} and status not in ('closed','cancelled') and deleted_at is null limit 1`;
        if (busy || sellers.some((s) => s.id === seller.id)) continue;
      }
      const loc = ctx.locations.find(
        (l) => l.id === vehicle.truck_location_id && l.active && !l.deleted_at,
      );
      if (!seller || !loc || !routeStops.get(seller.id)?.size) continue;
      selected.push(vehicle);
      sellers.push(seller);
      stock.locations.push(loc);
    }
    if (weekday(date) !== 0)
      vans(d, c, /** @type {any} */ (stock), {
        daily: true,
        historical,
        vehicles: selected,
        sellers,
      });
    // Materialize only new-month targets, reusing the history's target generator.
    const [target] =
      await t`select 1 from sales_targets where month=${date.slice(0, 7)} and organization_id='sunpride' limit 1`;
    if (!target) {
      const targets = new DailyDataset(date, 1);
      if ((e.monthlySales.get(date.slice(0, 7)) ?? 0) > 0)
        management(targets, c, e, { targetsOnly: true });
      else {
        // A month beginning on Sunday still needs a real budget, not a zero target.
        const previous = (await owned(t, "sales_targets"))
          .filter((r) => r.month && r.month < date.slice(0, 7))
          .sort((a, b) => String(b.month).localeCompare(String(a.month)));
        const month = previous[0]?.month;
        if (!month) throw new Error("Demo monthly target baseline is missing");
        for (const source of previous.filter((r) => r.month === month)) {
          const values = Object.fromEntries(
            [
              "organization_id",
              "subject_kind",
              "level",
              "target_key",
              "amount_centavos",
              "profile_id",
              "team_id",
              "territory_id",
              "period",
              "metric",
              "value",
            ].map((k) => [k, source[k]]),
          );
          const target = targets.add("sales_targets", `carry-${source.id}`, {
            ...values,
            month: date.slice(0, 7),
            effective_from: new Date(
              at(`${date.slice(0, 7)}-01`),
            ).toISOString(),
            effective_to: new Date(
              at(`${nextMonth(date.slice(0, 7))}-01`),
            ).toISOString(),
            revision_at: targets.epoch,
            source_ref: "sample",
            notes: `Sample monthly budget carried from ${month}; Sunday has no selling activity.`,
            created_by: "system:sample",
          });
          targets.event("sales_target", `carry-${source.id}`, {
            targetId: target.id,
            month: date.slice(0, 7),
            level: source.level,
            key: source.target_key,
            amountCentavos: Number(source.amount_centavos),
            carriedFrom: month,
          });
        }
      }
      for (const [table, rows] of targets.tables)
        for (const r of rows) {
          const marker = targets.markers.find((m) => m.row_id === r.id);
          d.tables.set(table, [...d.rows(table), r]);
          if (marker) d.markers.push(marker);
        }
    }
    // Existing live locations are never overwritten (they may be real phone positions).
    d.tables.delete("live_locations");
    d.markers = d.markers.filter((m) => m.table_name !== "live_locations");
    // Business timestamps for today's generated work cannot be in the future. Compress
    // the reference noon snapshot into elapsed time; preserve the unstarted stops.
    if (!historical) {
      const compress = (/** @type {any} */ x) => {
        if (typeof x === "string" && /^\d{4}-\d\d-\d\dT/.test(x))
          return new Date(stock.time(Date.parse(x))).toISOString();
        return x;
      };
      for (const rows of d.tables.values())
        for (const r of rows) {
          if (alreadyTimed.has(r.id)) continue;
          for (const key of Object.keys(r))
            if (key !== "effective_to" && key !== "requested_to")
              r[key] = compress(r[key]);
        }
      for (const marker of d.markers)
        if (!alreadyTimed.has(marker.row_id)) {
          marker.created_at = compress(marker.created_at);
          marker.updated_at = compress(marker.updated_at);
        }
      for (const visit of d.rows("visit_executions"))
        if (visit.checked_out_at && visit.checked_in_at)
          visit.call_duration_ms = Math.max(
            0,
            Date.parse(visit.checked_out_at) - Date.parse(visit.checked_in_at),
          );
      for (const sale of d.rows("van_sales"))
        sale.receipt.soldAt = stock.time(sale.receipt.soldAt);
      for (const event of pending) event.time = stock.time(event.time);
    }
    await finalizePlans(t, d, date, api);
    // Fund the generated demand with genuine receipts before loads/issues. Never set balances.
    /** @type {Map<number,number>} */ const demand = new Map();
    for (const event of pending)
      for (const l of event.lines)
        if (l.from === 0) demand.set(l.p, (demand.get(l.p) ?? 0) + l.qty);
    const supply = [...demand].map(([pi, qty]) => ({
      productId: c.products[pi].id,
      fromLocationId: null,
      toLocationId: depot.id,
      quantityBase: qty,
      uom: "PC",
      lotId: lots[pi]?.id,
      unitCostMinor: c.products[pi].cost,
    }));
    if (supply.length)
      await stock.post({
        key: "supply",
        kind: "goods_receipt",
        sourceId: `sample:daily:${date}`,
        time: stock.time(at(date, 5 * 60)),
        lines: supply,
      });
    for (const event of pending.sort(
      (a, b) => a.time - b.time || a.key.localeCompare(b.key),
    ))
      await stock.post({
        ...event,
        lines: event.lines
          .filter((/** @type {any} */ l) => l.qty > 0)
          .map((/** @type {any} */ l) => ({
            productId: c.products[l.p].id,
            fromLocationId: l.from === null ? null : stock.locations[l.from].id,
            toLocationId: l.to === null ? null : stock.locations[l.to].id,
            quantityBase: l.qty,
            uom: "PC",
            lotId: lots[l.p]?.id,
            unitCostMinor: c.products[l.p].cost,
          })),
      });
    for (const rows of d.tables.values())
      for (const r of rows)
        for (const key of Object.keys(r))
          if (typeof r[key] === "string" && movementIds.has(r[key]))
            r[key] = movementIds.get(r[key]);
    for (const o of d.rows("orders")) {
      o.subtotal_centavos = Math.round(Number(o.subtotal) * 100);
      o.total_centavos = Math.round(Number(o.total) * 100);
      o.amount_known = true;
    }
    for (const a of d.rows("visit_activities"))
      if (a.activity_kind === "order_intent")
        d.add(
          "order_intent_queue",
          a.id,
          { activity_id: a.id, status: "captured" },
          a.created_at,
        );
    const summary = {
      date,
      duplicate: false,
      orders: d.rows("orders").length,
      visits: d.rows("visit_executions").length,
      planned: d.rows("planned_visits").length,
      trips: d.rows("van_trips").length,
      closedTrips: closed,
      salesCentavos: d
        .rows("orders")
        .filter((o) => !["draft", "rejected", "voided"].includes(o.status))
        .reduce((n, o) => n + o.total_centavos, 0),
    };
    d.event(
      "daily",
      "manifest",
      summary,
      Math.min(Date.now(), at(date, 12 * 60)),
    );
    await persist(t, d);
    await seedTpm(t, date);
    await extendTowerSamples(t, date);
    // xmin scopes this capture to this transaction, never a concurrent tester insert.
    for (const table of STOCK_TABLES) {
      const rows = await t.unsafe(
        `select r.id from ${ident(table)} r where r.xmin=pg_current_xact_id()::text::xid and not exists(select 1 from sample_data_rows m where m.table_name=$1 and m.row_id=r.id::text)`,
        [table],
      );
      for (const r of rows) await markNative(t, table, String(r.id));
    }
    const feed =
      await t`select seq::text from change_log where xmin=pg_current_xact_id()::text::xid`;
    for (const r of feed) await markNative(t, "change_log", r.seq);
    const { publish } = await import(new URL("core/realtime.js", api).href);
    for (const topic of ["analytics", "coverage", "visits", "inventory", "van"])
      await publish(t, topic);
    return summary;
  });
}

/** Append every missing Manila business day after the historical seed, without a reset.
 * --date and --through are inclusive end dates, not a request to skip missing earlier days.
 * @param {Db} db @param {{date?:string}} [options] */
export async function advanceDemo(db, { date = todayManila() } = {}) {
  new Dataset(date, 1);
  if (date > todayManila())
    throw new Error("Demo cannot advance into the future");
  const [manifest] =
    await db`select a.details from audit_logs a join sample_data_rows m on m.row_id=a.id::text where m.batch=${BATCH} and m.key='audit_logs:manifest'`;
  if (!manifest)
    throw new Error("Demo daily advance requires an existing seeded company");
  await ensureCallflowSamples(db); // F-006 F-107: additive policies for existing demos, never reset.
  await tx(db, seedSpecMasters);
  const original = JSON.parse(manifest.details);
  await seedVanOps(db);
  const days = [];
  for (
    let day = plusDays(original.anchorDate, 1);
    day <= date;
    day = plusDays(day, 1)
  )
    days.push(await advanceDay(db, day, original.startDate));
  await seedFiscal(db);
  const availability = await seedAvailability(db, date);
  return {
    batch: BATCH,
    availability,
    through: date,
    advanced: days.filter((d) => !d.duplicate).length,
    days,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  /** @type {string|undefined} */ let date;
  let invalid = false;
  for (let i = 0; i < args.length; i++) {
    if (["--date", "--through"].includes(args[i]) && args[i + 1] && !date)
      date = args[++i];
    else invalid = true;
  }
  if (!process.env.DATABASE_URL || invalid) {
    console.error(
      "Usage: DATABASE_URL=… bun packages/db/seed/daily.js [--date YYYY-MM-DD | --through YYYY-MM-DD]",
    );
    process.exitCode = 2;
  } else {
    const db = createDb(process.env.DATABASE_URL, { max: 1 });
    try {
      const result = await advanceDemo(db, { date });
      const modernTrade = await seedModernTrade(db);
      const distributorSamples = await seedDistributors(db, {
        anchorDate: date,
      });
      console.log(JSON.stringify({ ...result, distributorSamples, modernTrade }, null, 2));
    } catch {
      console.error(
        "Demo daily advance failed; no partial day was committed. Check sample ownership, migrations and active sample masters.",
      );
      process.exitCode = 1;
    } finally {
      await db.close();
    }
  }
}
