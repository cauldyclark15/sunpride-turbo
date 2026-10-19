import {
  ACTOR,
  ORGANIZATION as org,
  at,
  nextMonth,
  plusDays,
  rowId,
  weekday,
} from "./store.js";
import { CHANNELS } from "./company.js";

/** Largest remainder distributes integer centavos without a one-cent contradiction.
 * @param {number} total @param {number[]} weights */
function apportion(total, weights) {
  const normalized = weights.some((w) => w > 0)
    ? weights
    : weights.map(() => 1);
  const sum = normalized.reduce((a, b) => a + b, 0);
  const raw = normalized.map((w) => (total * w) / sum);
  const parts = raw.map(Math.floor);
  const order = raw
    .map((x, i) => ({ i, remainder: x - parts[i] }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const remaining = total - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remaining; i++) parts[order[i % order.length].i]++;
  return parts;
}
/** @param {string} first @param {string} last */
function sellingDays(first, last) {
  let n = 0;
  for (let date = first; date <= last; date = plusDays(date, 1))
    if (weekday(date) !== 0) n++;
  return n;
}

/** @param {import('./store.js').Dataset} d @param {import('./company.js').Company} c @param {import('./execution.js').Execution} e */
export function management(d, c, e) {
  const targetMonths = e.months.slice(-3);
  for (const month of targetMonths) {
    const current = month === d.anchorDate.slice(0, 7);
    const fullDays = sellingDays(
      `${month}-01`,
      plusDays(`${nextMonth(month)}-01`, -1),
    );
    const elapsed = current
      ? sellingDays(`${month}-01`, d.anchorDate)
      : fullDays;
    const sales = e.monthlySales.get(month) ?? 0;
    const total = Math.round(
      ((sales / (current ? 0.92 : 0.96)) * fullDays) / Math.max(1, elapsed),
    );
    const actuals = c.agents.map(
      (a) => e.agentSales.get(`${month}-${a.index}`) ?? 0,
    );
    const territoryActuals = [0, 1, 2, 3].map((t) =>
      actuals.slice(t * 3, t * 3 + 3).reduce((a, b) => a + b, 0),
    );
    const weak = Math.min(
      total,
      Math.round(
        ((territoryActuals[3] / 0.75) * fullDays) / Math.max(1, elapsed),
      ),
    );
    const territoryTargets = [
      ...apportion(total - weak, territoryActuals.slice(0, 3)),
      weak,
    ];
    /** @type {number[]} */
    const agentTargets = [];
    for (let ti = 0; ti < 4; ti++)
      agentTargets.push(
        ...apportion(
          territoryTargets[ti],
          actuals
            .slice(ti * 3, ti * 3 + 3)
            .map(
              (amount, j) =>
                amount /
                ([1, 6].includes(ti * 3 + j)
                  ? 0.7
                  : ti * 3 + j === 0
                    ? 1.2
                    : 1),
            ),
        ),
      );
    const channels = apportion(
      total,
      CHANNELS.map((ch) => e.channelSales.get(`${month}-${ch}`) ?? 0),
    );
    const targets = [
      ...c.agents.map((a) => ({
        level: "agent",
        key: a.id,
        subject_kind: "employee",
        profile_id: a.id,
        team_id: null,
        territory_id: null,
        amount: agentTargets[a.index],
      })),
      ...c.territories.map((t, i) => ({
        level: "territory",
        key: t.id,
        subject_kind: "territory",
        profile_id: null,
        team_id: null,
        territory_id: t.id,
        amount: territoryTargets[i],
      })),
      ...c.targetTeams.map((t, i) => ({
        level: i ? "channel" : "company",
        key: i ? CHANNELS[i - 1] : "company",
        subject_kind: "team",
        profile_id: null,
        team_id: t.id,
        territory_id: null,
        amount: i ? channels[i - 1] : total,
      })),
    ];
    for (const target of targets) {
      const key = `${month}-${target.level}-${target.key}`;
      const row = d.add("sales_targets", key, {
        organization_id: org,
        subject_kind: ["company", "channel"].includes(target.level)
          ? target.level
          : target.subject_kind,
        month,
        level: target.level,
        target_key: target.key,
        amount_centavos: target.amount,
        revision_at: d.epoch,
        profile_id: target.profile_id,
        team_id: ["company", "channel"].includes(target.level)
          ? null
          : target.team_id,
        territory_id: target.territory_id,
        period: "monthly",
        metric: "sales_value",
        value: target.amount / 100,
        effective_from: new Date(at(`${month}-01`)).toISOString(),
        effective_to: new Date(at(`${nextMonth(month)}-01`)).toISOString(),
        source_ref: "sample",
        notes: `Demo ${target.level} target; ${target.key}. Money is numeric pesos in frozen 0114, not centavos.`,
        created_by: ACTOR,
      });
      d.event("sales_target", `target-${key}`, {
        targetId: row.id,
        month,
        level: target.level,
        key: target.key,
        amountCentavos: target.amount,
        teamId: target.team_id,
      });
    }
  }
  // AR snapshots reconcile to invoice orders, BO credits and exact FIFO collection
  // allocations as of each period cutoff. These are not unrelated invented balances.
  const allocations = d
    .rows("audit_logs")
    .filter((r) => r.action === "sample.collection_allocation")
    .map((r) => ({ at: r.created_at, ...JSON.parse(r.details) }));
  for (const month of e.months) {
    const cutoff =
      month === d.anchorDate.slice(0, 7)
        ? d.anchorDate
        : plusDays(`${nextMonth(month)}-01`, -1);
    for (const s of c.stores.filter((s) => s.customer.credit_limit > 0)) {
      const invoices = (e.invoices.get(s.customer.id) ?? [])
        .filter((i) => i.invoiceDate <= cutoff)
        .map((invoice) => {
          const paid = allocations
            .filter(
              (a) =>
                a.customerId === s.customer.id &&
                Date.parse(a.at) < at(plusDays(cutoff, 1)),
            )
            .flatMap((a) => a.allocations)
            .filter((a) => a.orderId === invoice.orderId)
            .reduce((sum, a) => sum + a.amountMinor, 0);
          return { ...invoice, remainingMinor: invoice.amountMinor - paid };
        });
      const buckets = [0, 0, 0, 0, 0];
      for (const i of invoices) {
        const overdue = Math.floor((at(cutoff) - at(i.dueDate)) / 86_400_000);
        buckets[
          overdue <= 0
            ? 0
            : overdue <= 30
              ? 1
              : overdue <= 60
                ? 2
                : overdue <= 90
                  ? 3
                  : 4
        ] += i.remainingMinor;
      }
      d.add(
        "admin_pack_records",
        `ar-${month}-${s.id}`,
        {
          organization_id: org,
          org_unit_id: c.units[s.territoryIndex].id,
          period: month,
          source: "sample",
          code: `SMP-AR-${month}-${s.index}`,
          kind: "ar_balance",
          details: {
            kind: "ar_balance",
            customerCode: s.customer.code,
            customerName: s.customer.name,
            outletId: s.id,
            customerId: s.customer.id,
            asOfDate: cutoff,
            termsDays: 30,
            currentMinor: buckets[0],
            days1to30Minor: buckets[1],
            days31to60Minor: buckets[2],
            days61to90Minor: buckets[3],
            over90Minor: buckets[4],
            invoices,
          },
        },
        at(cutoff, 12 * 60),
      );
    }
  }
  for (const [di, date] of e.dates.entries()) {
    if (weekday(date) === 0 || date >= d.anchorDate) continue;
    for (const [si, supervisor] of c.supervisors.entries()) {
      const due =
        si === 0
          ? [2, 4, 5].includes(weekday(date))
          : weekday(date) === 4 && Math.floor(di / 7) % 2 === 0;
      if (!due) continue;
      const trainee = c.agents[si * 6 + (Math.floor(di / 3) % 6)];
      const f = e.dayFacts.get(`${trainee.index}-${date}`);
      const session = d.add(
        "work_with_sessions",
        `${date}-${si}`,
        {
          organization_id: org,
          trainer_profile_id: supervisor.id,
          trainer_position_id: supervisor.position_id,
          trainee_profile_id: trainee.id,
          org_unit_id: trainee.org_unit_id,
          service_date: date,
          objective: "training",
          mode: "booking",
          status: "completed",
          training_log_topics: "Sample: call procedure and assortment gaps",
          training_log_trade_development: "Sample: improve outlet buying range",
          training_log_discussed_with_trainee: true,
          pre_call_documents: ["call_sheet"],
          mcp_planned: f?.planned ?? 0,
          mcp_done: f?.calls ?? 0,
          completed_at: new Date(at(date, 17 * 60)).toISOString(),
          created_by: supervisor.auth_subject,
          updated_by: supervisor.auth_subject,
        },
        at(date, 17 * 60),
      );
      for (const [i, area] of ["bcp", "psf"].entries())
        d.add("work_with_session_observations", `${session.id}-${i}`, {
          work_with_session_id: session.id,
          ordinal: i,
          area,
          item: "Sample sales presentation",
          rating: si ? "partial" : "met",
          remark: "Sample coaching observation",
        });
    }
    const reporters = [
      c.people.manager,
      ...c.supervisors,
      ...c.agents.filter((a) =>
        ["DS", "CDS", "SR_CDS"].includes(a.positionCode),
      ),
    ];
    for (const [i, p] of reporters.entries()) {
      if ((di + i) % 11 === 0) continue;
      d.add(
        "field_day_reports",
        `${date}-${p.id}`,
        {
          organization_id: org,
          profile_id: p.id,
          org_unit_id: p.org_unit_id,
          service_date: date,
          kind: "dar",
          revision: 1,
          remarks:
            "Sample daily activity report; missing reports intentionally retained",
          summary: {
            source: "sample",
            reportDate: date,
            status: "submitted",
            calls:
              [...e.dayFacts.values()].find(
                (f) => f.a.id === p.id && f.date === date,
              )?.calls ?? 0,
            workWithDone: d
              .rows("work_with_sessions")
              .filter(
                (s) => s.trainer_profile_id === p.id && s.service_date === date,
              ).length,
          },
          submitted_by: p.auth_subject,
          submitted_at: new Date(at(date, 20 * 60 + i)).toISOString(),
        },
        at(date, 20 * 60 + i),
      );
    }
  }
  for (const [i, a] of c.agents.entries()) {
    const date = plusDays(d.anchorDate, -14),
      supervisor = c.supervisors[Math.floor(i / 6)];
    const sheet = d.add(
      "talk_sheets",
      String(i),
      {
        organization_id: org,
        org_unit_id: a.org_unit_id,
        partner_name: a.name,
        partner_key: a.id,
        owner_profile_id: supervisor.id,
        meeting_date: date,
        next_contact_date: plusDays(d.anchorDate, i % 2 ? -2 : 3),
        acknowledged_by_name: a.name,
        status: "final",
        finalized_at: new Date(at(date, 17 * 60)).toISOString(),
        created_by: supervisor.auth_subject,
        updated_by: supervisor.auth_subject,
      },
      at(date, 17 * 60),
    );
    d.add("talk_sheet_items", String(i), {
      organization_id: org,
      sheet_id: sheet.id,
      position: 1,
      topic: "buying_accounts",
      gap: "Sample: missed stores and limited assortment",
      agreement: "Sample: recover five inactive stores",
      corrective_action: "Revisit priority stores with supervisor",
      responsible: a.name,
      timeline: plusDays(d.anchorDate, i % 2 ? -2 : 3),
      status: i % 2 ? "overdue" : "on_going",
      opened_on: date,
    });
    if (i < 3)
      d.event("per_diem_pending", `per-diem-${a.id}`, {
        profileId: a.id,
        ownerProfileId: supervisor.id,
        periodFrom: date,
        periodTo: plusDays(d.anchorDate, -1),
        dueAt: new Date(at(d.anchorDate, 17 * 60)).toISOString(),
        status: "pending",
        reason:
          "Sample: validate approved MCP and DAR evidence; allowance rates are outside this system",
      });
  }
  for (const f of e.dayFacts.values())
    d.add("agent_daily_metrics", `${f.a.index}-${f.date}`, {
      organization_id: org,
      profile_id: f.a.id,
      service_date: f.date,
      local_month: f.date.slice(0, 7),
      org_unit_id: f.a.org_unit_id,
      position_id: f.a.position_id,
      planned_calls: f.planned,
      calls: f.calls,
      productive_calls: f.productive,
      nonproductive_calls: f.calls - f.productive,
      productive_pct: f.calls ? (f.productive / f.calls) * 100 : null,
      planned_not_visited: f.planned - f.calls,
      visits: f.calls + f.open,
      unplanned_visits: 0,
      open_visits: f.open,
      skipped_visits: 0,
      late_sync_visits: 0,
      visits_missing_activities: 0,
      call_duration_ms: f.duration,
      timed_visits: f.calls,
      first_start_at: f.first,
      last_end_at: f.last,
      orders: f.orders,
      return_orders: f.returnOrders,
      buying_accounts: f.orders,
      sales_value: f.sales / 100,
      collections: f.collections,
      collections_pending_review: 0,
      collections_value: f.collectionMinor / 100,
      daily_calls_target: f.a.dailyCalls,
      productive_call_target_pct: f.a.positionCode === "KAS" ? 90 : 85,
      complete: f.date < d.anchorDate,
      rule_version: "sample-objective-v1",
      metrics_version: "sample-v1",
      computed_at: d.noon,
    });
}
