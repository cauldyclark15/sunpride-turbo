import { isProductive } from "../visits/productive.js";
import {
  addDays,
  date,
  dates,
  day,
  dto,
  fail,
  gate,
  hash,
  ms,
  noon,
  person,
  roster,
  standard,
  today,
  roleHas,
} from "./common.js";
import {
  DONE,
  OPEN,
  RULE_VERSION,
  classifyVisit,
  completenessOf,
  memoCategory,
  money,
  monthOf,
  percentOf,
  reportDueAt,
  reportKindFor,
} from "./rules.js";

/** @param {any} c @param {any} p @param {string} d */
export async function execution(c, p, d) {
  date(d);
  const planned =
    await c.db`select v.*, cp.status plan_status, s.sequence from planned_visits v join coverage_plans cp on cp.id=v.plan_id join coverage_plan_slots s on s.id=v.plan_slot_id where v.assignee_profile_id=${p.id} and v.service_date=${d} and v.deleted_at is null order by s.sequence,v.id`;
  const visits =
    await c.db`select v.*,o.name outlet_name,o.code outlet_code from visit_executions v join outlets o on o.id=v.outlet_id where v.assignee_profile_id=${p.id} and v.service_date=${d} and v.deleted_at is null order by v.checked_in_at,v.id`;
  if (planned.length > 200 || visits.length > 200)
    fail("Too many calls for one report", 422, "report_limit");
  const st = await standard(c, p, d);
  const results = [];
  for (const v of visits) {
    await gate(c, "report.read", v.org_unit_id);
    const acts =
      await c.db`select * from visit_activities where visit_id=${v.id} and deleted_at is null order by server_time,id limit 501`;
    if (acts.length > 500)
      fail("Too many activities for a complete report", 422, "report_limit");
    const activities = acts.map((/** @type {any} */ a) => ({
      ...a.activity,
      kind: a.activity_kind,
      activityKind: a.activity_kind,
    }));
    const rule = {
      ...dto(st ?? {}),
      productiveCallRule: st?.productive_call_rule ?? "any_listed_activity",
    };
    const collections =
      await c.db`select * from field_collections where visit_id=${v.id} and deleted_at is null and status='recorded' order by server_time,id limit 501`;
    if (collections.length > 500)
      fail("Too many collections for a complete report", 422, "report_limit");
    const evaluation = isProductive(
      {
        ...dto(v),
        activities,
        collections: collections.map(dto),
        activityKinds: acts.map((/** @type {any} */ a) => a.activity_kind),
      },
      rule,
    );
    const matched = planned.find(
      (/** @type {any} */ a) =>
        a.id === v.planned_visit_id && a.outlet_id === v.outlet_id,
    );
    const evidence =
      await c.db`select e.*, (select x.summary_after from execution_events x where x.entity_type='visit' and x.entity_id=e.id::text and x.kind='location.exception.decided' order by x.server_at desc limit 1) decision from visit_location_evidence e where e.visit_id=${v.id} and e.deleted_at is null order by e.server_time,e.id`;
    results.push({
      ...v,
      activities: acts,
      evaluation,
      collections,
      planned: matched ?? null,
      evidence,
    });
  }
  for (const p of planned)
    await gate(
      c,
      "report.read",
      p.approved_snapshot?.orgUnitId ?? p.approved_snapshot?.org_unit_id,
    );
  const sequenceIssues = new Map();
  let highest = -Infinity;
  for (const v of [...results]
    .filter((v) => v.checked_in_at && v.planned)
    .sort((a, b) => (ms(a.checked_in_at) ?? 0) - (ms(b.checked_in_at) ?? 0))) {
    const seq = v.planned.sequence;
    if (seq < highest)
      sequenceIssues.set(v.id, { sequence: seq, after: highest });
    highest = Math.max(highest, seq);
  }
  const active = planned.filter(
    (/** @type {any} */ a) => a.status === "planned",
  );
  const calls = results.filter(
    (v) =>
      DONE.has(v.state) &&
      v.source === "planned" &&
      v.planned?.status === "planned",
  );
  const productive = calls.filter((v) => v.evaluation.productive);
  const first = results
    .map((v) => ms(v.checked_in_at))
    .filter((v) => v !== null);
  const last = results
    .map((v) => ms(v.checked_out_at))
    .filter((v) => v !== null);
  const plannedDone = new Set(calls.map((v) => v.planned_visit_id)).size;
  return {
    planned,
    active,
    sequenceIssues,
    visits: results,
    standard: st,
    summary: {
      planned: active.length,
      plannedDone,
      notVisited: Math.max(0, active.length - plannedDone),
      unplanned: results.filter((v) => v.source === "unplanned").length,
      calls: calls.length,
      productiveCalls: productive.length,
      productivePct: percentOf(productive.length, calls.length),
      workWithSessions: 0,
      workWithCompleted: 0,
      firstCheckInAt: first.length ? Math.min(...first) : null,
      lastCheckOutAt: last.length ? Math.max(...last) : null,
      fieldMinutes:
        first.length && last.length
          ? Math.max(
              0,
              Math.round((Math.max(...last) - Math.min(...first)) / 60000),
            )
          : null,
    },
  };
}
/** @param {any} c @param {any} p @param {string} from @param {string} to */
export async function salesLines(c, p, from, to) {
  // Legacy order/line decimal pesos are converted EXACTLY in Postgres; targets are already centavos.
  const rows =
    await c.db`select o.id order_id,o.customer_code,o.sap_document_number,o.order_number,o.source_location_id,(o.created_at at time zone 'Asia/Manila')::date service_date,l.product_code,l.description,l.quantity,(l.line_total*100)::bigint cents,pr.category,cu.name customer_name,loc.org_unit_id source_unit from orders o join order_lines l on l.order_id=o.id and l.deleted_at is null left join products pr on pr.code=l.product_code left join customers cu on cu.code=o.customer_code left join inventory_locations loc on loc.id=o.source_location_id where (o.salesperson_subject=${p.user_id ?? ""} or o.salesperson_subject=${p.auth_subject ?? ""}) and o.status not in ('draft','rejected','voided') and o.deleted_at is null and (o.created_at at time zone 'Asia/Manila')::date between ${from}::date and ${to}::date order by o.created_at,o.id,l.id`;
  if (rows.length > 10000)
    fail("Too many order lines for one report", 422, "report_limit");
  for (const r of rows)
    if (r.source_location_id) await gate(c, "report.read", r.source_unit);
  return rows;
}
/** @param {any} c @param {any} a */
export async function dsr(c, a) {
  const d = date(a.serviceDate);
  const p = await person(c, a.profileId);
  const month = monthOf(d);
  const x = await execution(c, p, d);
  const lines = await salesLines(c, p, month.start, d);
  const targets =
    await c.db`select * from sales_targets where profile_id=${p.id} and metric='sales_value' and deleted_at is null and effective_from<=${noon(d)} and (effective_to is null or effective_to>${noon(d)}) order by effective_from desc`;
  const monthly = targets.find(
    (/** @type {any} */ t) => t.period === "monthly",
  );
  const daily = targets.find((/** @type {any} */ t) => t.period === "daily");
  const weekdays = x.standard?.selling_weekdays?.length
    ? x.standard.selling_weekdays
    : [1, 2, 3, 4, 5, 6];
  const sellingDay = weekdays.includes(new Date(d + "T00:00:00Z").getUTCDay());
  const sellingDaysInMonth = dates(month.start, month.end).filter((v) =>
    weekdays.includes(new Date(v + "T00:00:00Z").getUTCDay()),
  ).length;
  const monthlyValue = monthly ? Number(monthly.value) : null;
  const dailyValue = daily
    ? Number(daily.value)
    : monthly && sellingDay
      ? Math.round(Number(monthlyValue) / sellingDaysInMonth)
      : null;
  const categories = new Map(
    ["Canned", "Mixes", "Frozen"].map((category) => [
      category,
      {
        category,
        todaySales: 0,
        todayQuantity: 0,
        mtdSales: 0,
        mtdQuantity: 0,
      },
    ]),
  );
  const customers = new Map();
  const trend = dates(month.start, d).map((date) => ({
    date,
    sales: 0,
    cumulative: 0,
  }));
  for (const l of lines) {
    const cents = Number(l.cents);
    if (!Number.isSafeInteger(cents)) fail("Amount exceeds supported range");
    const isToday = day(l.service_date) === d;
    const category = memoCategory(l.category);
    const cat = categories.get(category) ?? {
      category,
      todaySales: 0,
      todayQuantity: 0,
      mtdSales: 0,
      mtdQuantity: 0,
    };
    cat.mtdSales += cents;
    cat.mtdQuantity += Number(l.quantity);
    if (isToday) {
      cat.todaySales += cents;
      cat.todayQuantity += Number(l.quantity);
    }
    categories.set(category, cat);
    const key = l.customer_code;
    const r = customers.get(key) ?? {
      key,
      outletId: null,
      outletCode: null,
      customerCode: key,
      name: l.customer_name ?? key,
      sequence: null,
      inRoutePlan: false,
      callStatus: null,
      matchedCodes: [],
      todaySales: 0,
      mtdSales: 0,
      invoiceNumbers: [],
      reasonCode: null,
      remarks: [],
    };
    r.mtdSales += cents;
    if (isToday) {
      r.todaySales += cents;
      if (!r.invoiceNumbers.includes(l.sap_document_number ?? l.order_number))
        r.invoiceNumbers.push(l.sap_document_number ?? l.order_number);
    }
    customers.set(key, r);
    const t = trend.find((t) => t.date === day(l.service_date));
    if (t) t.sales += cents;
  }
  for (const plan of x.active) {
    const snapshot = plan.approved_snapshot ?? {};
    let r = [...customers.values()].find(
      (r) => r.customerCode === snapshot.customerCode,
    );
    if (!r) {
      r = {
        key: plan.outlet_id,
        outletId: plan.outlet_id,
        outletCode: snapshot.outletCode ?? "",
        customerCode: null,
        name: snapshot.outletName ?? "Planned store",
        sequence: plan.sequence,
        inRoutePlan: true,
        callStatus: "not_visited",
        matchedCodes: [],
        todaySales: 0,
        mtdSales: 0,
        invoiceNumbers: [],
        reasonCode: null,
        remarks: [],
      };
      customers.set(r.key, r);
    }
    r.inRoutePlan = true;
    const v =
      plan.visit ?? x.visits.find((v) => v.planned_visit_id === plan.id);
    if (v) {
      r.callStatus = OPEN.has(v.state)
        ? "open"
        : v.evaluation.productive
          ? "productive"
          : "nonproductive";
      r.reasonCode = v.reason_code;
      const codes = /** @type {Record<string,string>} */ ({
        order_intent: "purchase_order",
        merchandising: "merchandising",
        inventory_check: "inventory_retrieval",
      });
      r.matchedCodes = v.evaluation.productive
        ? [
            ...new Set(
              v.activities
                .map((/** @type {any} */ a) => codes[a.activity_kind])
                .filter(Boolean),
            ),
          ]
        : [];
      r.remarks = v.activities
        .filter((/** @type {any} */ a) => a.activity_kind === "note")
        .map(
          (/** @type {any} */ a) => a.activity.note ?? a.activity.text ?? "",
        );
    }
  }
  let cum = 0;
  for (const t of trend) {
    cum += t.sales;
    t.cumulative = cum;
  }
  const total = [...categories.values()].reduce((s, v) => s + v.mtdSales, 0);
  const salesToday = [...categories.values()].reduce(
    (s, v) => s + v.todaySales,
    0,
  );
  const programs = new Map();
  for (const v of x.visits)
    for (const a of v.activities)
      if (a.activity_kind === "promotion") {
        const ref = a.activity.programRef ?? "Unspecified program";
        const r = programs.get(ref) ?? {
          programRef: ref,
          executed: 0,
          notExecuted: 0,
          notApplicable: 0,
        };
        if ((a.activity.finding ?? a.activity.result) === "not_applicable")
          r.notApplicable++;
        else if (
          a.activity.executed === false ||
          (a.activity.finding ?? a.activity.result) === "not_executed"
        )
          r.notExecuted++;
        else r.executed++;
        programs.set(ref, r);
      }
  const prevMonthEnd = addDays(month.start, -1);
  const prevStart = prevMonthEnd.slice(0, 7) + "-01";
  const prevTo =
    prevMonthEnd.slice(0, 8) +
    String(
      Math.min(Number(d.slice(8)), Number(prevMonthEnd.slice(8))),
    ).padStart(2, "0");
  const priorLines = await salesLines(c, p, prevStart, prevTo);
  return {
    serviceDate: d,
    orderCountToday: new Set(
      lines
        .filter((/** @type {any} */ l) => day(l.service_date) === d)
        .map((/** @type {any} */ l) => l.order_id),
    ).size,
    localMonth: d.slice(0, 7),
    ruleVersion: RULE_VERSION,
    salesman: {
      profileId: p.id,
      name: p.name,
      employeeCode: p.employee_code,
      position: p.position_label,
    },
    areaCovered: [
      ...new Set(
        x.active
          .map(
            (/** @type {any} */ plan) =>
              plan.approved_snapshot.routeCode ??
              plan.approved_snapshot.territoryCode,
          )
          .filter(Boolean),
      ),
    ],
    invoiceNumbers: [
      ...new Set([...customers.values()].flatMap((r) => r.invoiceNumbers)),
    ],
    sellingDay,
    sellingDaysInMonth,
    targets: {
      daily: dailyValue,
      dailySource: daily
        ? "set"
        : dailyValue !== null
          ? "derived_from_monthly"
          : null,
      monthly: monthlyValue,
      sourceRef: monthly?.source_ref ?? daily?.source_ref ?? null,
    },
    totals: {
      todaySales: salesToday,
      todayPct: percentOf(salesToday, dailyValue),
      mtdSales: total,
      mtdPct: percentOf(total, monthlyValue),
      balanceToSell:
        monthlyValue === null ? null : Math.max(0, monthlyValue - total),
    },
    calls: {
      planned: x.summary.planned,
      calls: x.summary.calls,
      productiveCalls: x.summary.productiveCalls,
      productivePct: x.summary.productivePct,
      dailyCallsTarget: x.standard?.daily_calls_target ?? null,
      productiveCallTargetPct: x.standard?.productive_call_target_pct ?? null,
      productiveCallRule:
        x.standard?.productive_call_rule ?? "any_listed_activity",
    },
    customers: [...customers.values()],
    categories: [...categories.values()],
    programs: [...programs.values()],
    trend,
    priorMtd: priorLines.reduce(
      (/** @type {number} */ s, /** @type {any} */ l) => s + Number(l.cents),
      0,
    ),
  };
}
/** @param {any} c @param {any} a */
export async function wholeTeam(c, a) {
  const people = await roster(c, a);
  const rows = /** @type {any[]} */ ([]);
  for (const p of people) {
    const r = await dsr(c, { ...a, profileId: p.id });
    rows.push({
      profileId: p.id,
      name: p.name,
      ...r.totals,
      target: r.targets.monthly,
      dailyTarget: r.targets.daily,
      calls: r.calls.calls,
      productive: r.calls.productiveCalls,
      trend: r.trend,
      prior: r.priorMtd,
    });
  }
  const sum = (/** @type {string} */ k) =>
    rows.reduce((s, /** @type {any} */ r) => s + (r[k] ?? 0), 0);
  return {
    serviceDate: date(a.serviceDate),
    rows,
    totals: {
      todaySales: sum("todaySales"),
      mtdSales: sum("mtdSales"),
      target: rows.every((r) => r.target !== null) ? sum("target") : null,
      prior: sum("prior"),
    },
    definition:
      "Order lines on orders other than draft, rejected or voided; Manila order date. Amounts in centavos.",
  };
}
/** @param {any} c @param {any} a */
export async function perDiem(c, a) {
  const period = dates(a.from, a.to);
  if (a.from.slice(0, 7) !== a.to.slice(0, 7))
    fail("A claim period stays inside one month");
  const members =
    c.actor.role === "sales"
      ? [await person(c, c.actor.profileId)]
      : a.profileId &&
          roleHas(c.actor.role, "perdiem.approve") &&
          !roleHas(c.actor.role, "people.read")
        ? [await person(c, a.profileId)]
        : await roster(c, { ...a, serviceDate: a.to });
  const p = a.profileId
    ? members.find((/** @type {any} */ p) => p.id === a.profileId)
    : null;
  if (a.profileId && !p)
    fail("Person is outside this team", 403, "out_of_scope");
  const people = members.map((/** @type {any} */ p) => ({
    profileId: p.id,
    name: p.name,
    employeeCode: p.employee_code,
    positionLabel: p.position_label,
    channel: p.channel ?? p.channel_scope ?? "Unassigned",
    latest: null,
  }));
  if (!p)
    return {
      localMonth: a.from.slice(0, 7),
      from: a.from,
      to: a.to,
      ruleVersion: RULE_VERSION,
      truncated: false,
      people,
      selected: null,
    };
  const items = [];
  const days = /** @type {any[]} */ ([]);
  const hashFacts = [];
  for (const d of period) {
    const x = await execution(c, p, d);
    for (const v of x.visits) {
      const required =
        await c.db`select r.id,r.intent,r.source_ref,a.kind from visit_activity_rules r join visit_activity_rule_activities a on a.visit_activity_rule_id=r.id where r.organization_id=${v.organization_id} and r.intent in ${c.db(v.intents.length ? v.intents : [""])} and r.deleted_at is null and a.deleted_at is null and a.required and r.effective_from<=${v.started_at ?? v.checked_in_at ?? noon(d)} and (r.effective_to is null or r.effective_to>${v.started_at ?? v.checked_in_at ?? noon(d)}) order by r.intent,a.ordinal`;
      const recorded = v.activities.map(
        (/** @type {any} */ a) => a.activity_kind,
      );
      const missing =
        v.outcome === "nonproductive"
          ? []
          : [
              ...new Set([
                ...required.map((/** @type {any} */ r) => r.kind),
                ...(v.missing_activities ?? []),
              ]),
            ].filter((k) => !recorded.includes(k));
      const location = v.evidence.map((/** @type {any} */ e) => ({
        event: e.event,
        hasFix: e.latitude !== null && e.longitude !== null,
        status: e.decision ?? e.review_status,
      }));
      const facts = {
        source: v.source,
        state: v.state,
        hasPlannedLink: !!v.planned_visit_id,
        planned: v.planned
          ? { status: v.planned.status, planStatus: v.planned.plan_status }
          : null,
        location,
        lateReviewStatus: v.late_review_status,
        activityCount: recorded.length,
        hasCallSheet: recorded.includes("call_sheet"),
        callSheetRequired: required.some(
          (/** @type {any} */ r) => r.kind === "call_sheet",
        ),
        requiredMissing: missing,
      };
      items.push({
        id: v.id,
        visitId: v.id,
        serviceDate: d,
        kind: "visit",
        outletName: v.outlet_name,
        outletCode: v.outlet_code,
        sequence: v.planned?.sequence ?? null,
        checkedInAt: ms(v.checked_in_at),
        productivity: v.evaluation.productive ? "productive" : "nonproductive",
        missingForms: missing,
        ...classifyVisit(facts),
      });
      hashFacts.push({
        id: v.id,
        facts,
        required,
        activities: v.activities.map((/** @type {any} */ a) => ({
          id: a.id,
          kind: a.activity_kind,
          activity: a.activity,
        })),
        evidence: v.evidence,
        plan: v.planned,
      });
    }
    for (const plan of x.active)
      if (!x.visits.some((v) => v.planned_visit_id === plan.id))
        items.push({
          id: plan.id,
          visitId: null,
          serviceDate: d,
          kind: "not_visited",
          outletName: plan.approved_snapshot.outletName ?? "Planned store",
          outletCode: plan.approved_snapshot.outletCode ?? "",
          sequence: plan.sequence,
          checkedInAt: null,
          productivity: null,
          missingForms: [],
          status: "invalid",
          reasons: ["not_visited"],
          notes: [],
        });
    const own = items.filter((i) => i.serviceDate === d);
    const count = (/** @type {string} */ s) =>
      own.filter((i) => i.kind === "visit" && i.status === s).length;
    const line = {
      serviceDate: d,
      plannedStops: x.active.length,
      validCalls: count("valid"),
      heldCalls: count("held"),
      invalidCalls: count("invalid"),
      notVisited: own.filter((i) => i.kind === "not_visited").length,
      dayStatus: count("held") ? "held" : count("valid") ? "valid" : "none",
    };
    days.push(line);
    hashFacts.push({ d, planned: x.planned });
  }
  const contentHash = hash({ rule: RULE_VERSION, period, hashFacts });
  const decisions =
    await c.db`select v.*,p.name decider_name from per_diem_validations v join profiles p on p.id=v.decider_profile_id where v.profile_id=${p.id} and v.period_from=${a.from} and v.period_to=${a.to} order by v.decided_at desc limit 100`;
  const sum = (/** @type {string} */ key) =>
    days.reduce((s, /** @type {any} */ d) => s + d[key], 0);
  const totals = {
    plannedStops: sum("plannedStops"),
    validCalls: sum("validCalls"),
    heldCalls: sum("heldCalls"),
    invalidCalls: sum("invalidCalls"),
    notVisited: sum("notVisited"),
    validDays: days.filter((d) => d.dayStatus === "valid").length,
    heldDays: days.filter((d) => d.dayStatus === "held").length,
  };
  return {
    localMonth: a.from.slice(0, 7),
    from: a.from,
    to: a.to,
    ruleVersion: RULE_VERSION,
    truncated: false,
    people,
    selected: {
      profileId: p.id,
      name: p.name,
      positionLabel: p.position_label,
      canDecide:
        c.actor.profileId !== p.id &&
        c.actor.capabilities.has("perdiem.approve"),
      truncated: false,
      contentHash,
      totals,
      days,
      items,
      decisions: decisions.map((/** @type {any} */ d) => ({
        id: d.id,
        decision: d.decision,
        note: d.note,
        deciderName: d.decider_name,
        decidedAt: ms(d.decided_at),
        validCalls: d.valid_calls,
        validDays: d.valid_days,
        ruleVersion: d.rule_version,
        stale: d.content_hash !== contentHash,
      })),
    },
  };
}
/** @param {any} c @param {any} a */
export async function fieldDay(c, a) {
  const d = date(a.serviceDate);
  const p = await person(c, a.profileId ?? c.actor.profileId);
  const kind = reportKindFor(p.position_code);
  if (!kind) return null;
  const x = await execution(c, p, d);
  const sessions =
    await c.db`select w.*,p.name trainee_name from work_with_sessions w join profiles p on p.id=w.trainee_profile_id where w.trainer_profile_id=${p.id} and w.service_date=${d} order by w.id`;
  const subs =
    await c.db`select * from field_day_reports where profile_id=${p.id} and service_date=${d} order by revision`;
  const first = subs[0];
  const latest = subs.at(-1);
  const sellingDay = new Date(d + "T00:00:00Z").getUTCDay() !== 0;
  const kindStatus = completenessOf({
    serviceDate: d,
    sellingDay,
    firstSubmittedAt: ms(first?.submitted_at),
    now: c.now,
  });
  x.summary.workWithSessions = sessions.length;
  x.summary.workWithCompleted = sessions.filter(
    (/** @type {any} */ s) => s.status === "completed",
  ).length;
  const stops = [
    ...x.planned,
    ...x.visits
      .filter((v) => v.source === "unplanned")
      .map((v) => ({
        id: v.id,
        sequence: null,
        visit: v,
        status: v.state,
        approved_snapshot: {
          outletName: v.outlet_name,
          outletCode: v.outlet_code,
        },
      })),
  ].map((/** @type {any} */ plan) => {
    const v =
      plan.visit ?? x.visits.find((v) => v.planned_visit_id === plan.id);
    return {
      key: plan.id,
      source: v ? v.source : "not_visited",
      sequence: plan.sequence,
      outletName: plan.approved_snapshot.outletName ?? "Planned store",
      outletCode: plan.approved_snapshot.outletCode ?? "",
      routeCode: plan.approved_snapshot.routeCode ?? null,
      state: v?.state ?? plan.status,
      checkedInAt: ms(v?.checked_in_at),
      checkedOutAt: ms(v?.checked_out_at),
      callStatus: !v
        ? "not_visited"
        : OPEN.has(v.state)
          ? "open"
          : v.evaluation.productive
            ? "productive"
            : "nonproductive",
      matchedCodes: [],
      activityKinds:
        v?.activities.map((/** @type {any} */ a) => a.activity_kind) ?? [],
      collections: v?.collections.length ?? 0,
      notes:
        v?.activities
          .filter((/** @type {any} */ a) => a.activity_kind === "note")
          .map(
            (/** @type {any} */ a) => a.activity.note ?? a.activity.text ?? "",
          ) ?? [],
      reasonCode: v?.reason_code ?? null,
      callMinutes: v?.call_duration_ms
        ? Math.round(Number(v.call_duration_ms) / 60000)
        : null,
    };
  });
  const blocked =
    d > today(c.now)
      ? "A report cannot be filed for a future day"
      : d < addDays(today(c.now), -7)
        ? "Reports can be filed up to 7 days back"
        : subs.length >= 20
          ? "This day has reached its correction limit"
          : null;
  return {
    serviceDate: d,
    kind,
    status: kindStatus,
    sourceRef: "Memo 2026-01-20; daily 10 PM Manila close",
    summary: x.summary,
    sellingDay,
    person: {
      profileId: p.id,
      name: p.name,
      employeeCode: p.employee_code,
      positionLabel: p.position_label,
      positionCode: p.position_code,
      unitName: null,
    },
    dueAt: reportDueAt(d),
    canSubmit:
      c.actor.profileId === p.id &&
      c.actor.capabilities.has("deliverable.submit") &&
      !blocked,
    submitBlockedReason: blocked,
    standard: x.standard
      ? {
          sourceRef: x.standard.source_ref,
          dailyCallsTarget: x.standard.daily_calls_target,
          productiveCallTargetPct: x.standard.productive_call_target_pct,
        }
      : null,
    callsTargetMet: x.standard?.daily_calls_target
      ? x.summary.calls >= x.standard.daily_calls_target
      : null,
    productiveTargetMet:
      x.summary.productivePct !== null &&
      x.standard?.productive_call_target_pct !== null
        ? x.summary.productivePct >= x.standard.productive_call_target_pct
        : null,
    stops,
    workWith: sessions.map((/** @type {any} */ s) => ({
      sessionId: s.id,
      status: s.status,
      objective: s.objective,
      mode: s.mode,
      mcpPlanned: s.mcp_planned,
      mcpDone: s.mcp_done,
      traineeName: s.trainee_name,
    })),
    routes: [...new Set(stops.map((s) => s.routeCode))].map((routeCode) => {
      const own = stops.filter((s) => s.routeCode === routeCode);
      const calls = own.filter(
        (s) =>
          s.source === "planned" &&
          ["productive", "nonproductive"].includes(s.callStatus),
      ).length;
      const productiveCalls = own.filter(
        (s) => s.source === "planned" && s.callStatus === "productive",
      ).length;
      return {
        routeCode,
        routeName: null,
        calls,
        productiveCalls,
        productivePct: percentOf(productiveCalls, calls),
      };
    }),
    submission: latest
      ? {
          submittedAt: ms(latest.submitted_at),
          remarks: latest.remarks,
          summary: latest.summary,
          revision: latest.revision,
          submittedByName: p.name,
          firstSubmittedAt: ms(first.submitted_at),
        }
      : null,
    revisions: subs.length,
    frozenSummary: latest?.summary ?? null,
  };
}
/** @param {any} c @param {any} a */
export async function completeness(c, a) {
  const end = date(a.endDate);
  const count = a.days ?? 7;
  if (!Number.isInteger(count) || count < 1 || count > 14)
    fail("Choose 1–14 days", 400);
  const ds = dates(addDays(end, 1 - count), end, 14);
  const members = await roster(c, a, true);
  const people = /** @type {any[]} */ ([]);
  for (const p of members) {
    const kind = reportKindFor(p.position_code);
    if (!kind || (a.kind && a.kind !== kind)) continue;
    const days = [];
    for (const d of ds) {
      const subs =
        await c.db`select submitted_at,revision from field_day_reports where profile_id=${p.id} and service_date=${d} order by revision`;
      days.push({
        serviceDate: d,
        status: completenessOf({
          serviceDate: d,
          sellingDay: new Date(d + "T00:00:00Z").getUTCDay() !== 0,
          firstSubmittedAt: ms(subs[0]?.submitted_at),
          now: c.now,
        }),
        submittedAt: ms(subs[0]?.submitted_at),
        revisions: subs.length,
      });
    }
    people.push({
      profileId: p.id,
      name: p.name,
      employeeCode: p.employee_code,
      positionLabel: p.position_label,
      kind,
      days,
    });
  }
  return {
    dates: ds,
    truncated: false,
    units: [],
    people,
    totals: ds.map((d) => {
      const states = people.flatMap((p) =>
        p.days.filter((/** @type {any} */ v) => v.serviceDate === d),
      );
      return {
        serviceDate: d,
        required: states.filter(
          (v) => !["off_day", "upcoming"].includes(v.status),
        ).length,
        submitted: states.filter((v) => v.status === "submitted").length,
        late: states.filter((v) => v.status === "late").length,
        missing: states.filter((v) => v.status === "missing").length,
      };
    }),
  };
}
