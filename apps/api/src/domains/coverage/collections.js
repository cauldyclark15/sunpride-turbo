// F-613: collections plan in Money. Promise-to-pay, a collector's route and post-dated / bounced cheque
// tracking on SAP replicated open items. The labelled sample office AR snapshot is used only before
// this gateway has any AR feed; it is never resurrected after a withdrawal. Nothing here is
// an AR ledger: balances are never posted or reduced by these records.
import { tx } from "@sunpride/db/client";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import {
  requireCapability as coreCapability,
  roleHas,
} from "../../core/capabilities.js";
import { COLLECTOR_ACCESS } from "./collector-context.js";
import { sapCollectionItems } from "./collection-ar.js";
import { invalid, conflict, notFound } from "../../core/errors.js";
import { currentActor } from "../van/access.js";
import { scopeFor } from "../analytics/measures.js";
import { manilaDate, DAY } from "./model.js";
import { required } from "../org/model.js";

/** Narrow server-minted adapter, never a new global planner role. @param {any} c @param {string} cap @param {string|null} [unit] */
async function requireCapability(c, cap, unit) {
  if (cap === "collections.plan" && c[COLLECTOR_ACCESS])
    return c[COLLECTOR_ACCESS].authorize(c, unit);
  return coreCapability(c, cap, unit);
}
const hash = (/** @type {any} */ v) => sha256Hex(canonicalJson(v));
const SOURCE = "Sample office AR snapshot — not live SAP";
const REASONS = [
  "promise_due",
  "promise_overdue",
  "cheque_pickup",
  "cheque_replacement",
  "overdue_balance",
  "manual",
];
/** Allowed cheque transitions; a post-dated cheque cannot be deposited before its date. */
const NEXT = /** @type {Record<string,string[]>} */ ({
  received: ["deposited"],
  deposited: ["cleared", "bounced"],
  bounced: ["replaced"],
  cleared: [],
  replaced: [],
});
/** Manila calendar day of a date column (all callers pass NOT NULL columns). @param {any} d @returns {string} */
const dayText = (d) =>
  typeof d === "string"
    ? d.slice(0, 10)
    : new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
/** @param {string} d @param {number} n */
const plus = (d, n) =>
  new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
/** @param {any} v @param {string} label */
function minor(v, label) {
  if (!Number.isSafeInteger(v) || v <= 0 || v > 99_999_999_999)
    throw invalid(`${label} must be a positive amount`);
  return v;
}
/** @param {any} v @param {string} label */
function isoDay(v, label) {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    Number.isNaN(Date.parse(v))
  )
    throw invalid(`${label} must be a YYYY-MM-DD day`);
  return v;
}

/** The customer, its current owning unit and its latest sample AR snapshot, gated for the caller.
 * @param {any} c @param {string} code @param {string} today @param {string} [cap] */
export async function customerFor(c, code, today, cap = "collections.plan") {
  const rows =
    await c.db`select s.customer_code,s.name,s.owner_unit_id,s.territory_name from analytics_store_scope s where s.customer_code=${required(code, "Customer", 60)} and s.status='active' order by s.id limit 501`;
  if (rows.length > 500)
    throw conflict("Narrow this shared accounting customer's store scope");
  for (const store of rows) {
    if (!store.owner_unit_id) continue;
    try {
      await requireCapability(c, cap, store.owner_unit_id);
    } catch {
      continue;
    }
    return { store, ar: await latestAr(c.db, [store.customer_code], today) };
  }
  throw notFound("Customer not found in the current collection scope");
}
/** @param {any} db @param {string[]} codes @param {string} today */
export async function latestAr(db, codes, today) {
  if (!codes.length) return new Map();
  const sap = await sapCollectionItems(db, codes);
  if (sap !== null) return sap;
  const rows =
    await db`select distinct on (details->>'customerCode') id,details from admin_pack_records where kind='ar_balance' and source='sample'
      and details->>'customerCode' in ${db(codes)} and details->>'asOfDate'<=${today}
      order by details->>'customerCode',details->>'asOfDate' desc,created_at desc,id desc`;
  return new Map(
    rows.map((/** @type {any} */ r) => {
      const d = r.details;
      const items = (Array.isArray(d.invoices) ? d.invoices : [])
        .filter((/** @type {any} */ i) => Number(i.remainingMinor) > 0)
        .map((/** @type {any} */ i) => ({
          ref: String(i.orderId),
          invoiceDate: i.invoiceDate,
          dueDate: i.dueDate,
          remainingMinor: Number(i.remainingMinor),
        }));
      const total = [
        "currentMinor",
        "days1to30Minor",
        "days31to60Minor",
        "days61to90Minor",
        "over90Minor",
      ].reduce((a, k) => a + Number(d[k] ?? 0), 0);
      return [
        d.customerCode,
        {
          snapshotId: r.id,
          source: SOURCE,
          freshness: "sample",
          sourceReference: { kind: "sample_office", snapshotId: r.id },
          sourceHash: hash({ kind: "sample_office", snapshotId: r.id }),
          asOfDate: d.asOfDate,
          totalMinor: total,
          overdueMinor: total - Number(d.currentMinor ?? 0),
          over60Minor:
            Number(d.days61to90Minor ?? 0) + Number(d.over90Minor ?? 0),
          items,
        },
      ];
    }),
  );
}

/** @param {any} ctx */
export async function createPromise(ctx) {
  const b = ctx.body ?? {};
  const key = required(b.idempotencyKey, "Idempotency key", 100),
    note = required(b.note, "Note", 500),
    amount = minor(b.amountMinor, "Promised amount"),
    on = isoDay(b.promisedOn, "Promised day");
  const request = hash({
    c: b.customerCode,
    amount,
    on,
    note,
    ref: b.openItemRef ?? null,
  });
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor),
      c = { ...ctx, db, actor };
    await requireCapability(c, "collections.plan");
    await customerFor(c, b.customerCode, manilaDate(ctx.now));
    const [old] =
      await db`select id,request_hash,org_unit_id from collection_promises where created_by=${actor.profileId} and client_key=${key}`;
    if (old) {
      await requireCapability(c, "collections.plan", old.org_unit_id);
      if (old.request_hash !== request)
        throw conflict(
          "This key was already used for a different promise",
          "idempotency_conflict",
        );
      return { id: old.id };
    }
    const today = manilaDate(ctx.now);
    if (on < today || on > plus(today, 60))
      throw invalid("A promise is for today or a day within the next 60 days");
    const { store, ar } = await customerFor(c, b.customerCode, today);
    const snap = ar.get(store.customer_code);
    if (b.sourceHash && b.sourceHash !== snap?.sourceHash)
      throw conflict("AR open items changed; reconcile the retained promise");
    await db`select pg_advisory_xact_lock(hashtextextended(${"collection-promise:" + store.customer_code},0))`;
    if (!snap || snap.totalMinor <= 0)
      throw conflict("This customer has no open balance in the AR snapshot");
    let ref = null;
    if (b.openItemRef != null) {
      const item = snap.items.find(
        (/** @type {any} */ i) => i.ref === b.openItemRef,
      );
      if (!item) throw invalid("Choose one of the customer's open items");
      if (amount > item.remainingMinor)
        throw invalid("The promise exceeds that open item's remaining amount");
      ref = item.ref;
    }
    const [{ promised }] =
      await db`select coalesce(sum(amount_minor),0)::bigint promised from collection_promises where customer_code=${store.customer_code} and status='open'`;
    if (Number(promised) + amount > snap.totalMinor)
      throw invalid("Open promises would exceed the customer's open balance");
    if (ref) {
      const [used] =
        await db`select coalesce(sum(amount_minor),0)::bigint n from collection_promises where customer_code=${store.customer_code} and open_item_ref=${ref} and status='open'`;
      const item = snap.items.find((/** @type {any} */ i) => i.ref === ref);
      if (Number(used.n) + amount > item.remainingMinor)
        throw invalid(
          "Open promises exceed that replicated open item's remaining amount",
        );
    }
    const [p] =
      await db`insert into collection_promises(org_unit_id,customer_code,open_item_ref,ar_snapshot_id,amount_minor,promised_on,note,created_by,client_key,request_hash,ar_source)
      values(${store.owner_unit_id},${store.customer_code},${ref},${snap.snapshotId},${amount},${on},${note},${actor.profileId},${key},${request},${snap.sourceReference ?? {}}) returning id`;
    ctx.platform?.publish?.("analytics");
    return { id: p.id };
  });
}

/** @param {any} ctx */
export async function settlePromise(ctx) {
  const b = ctx.body ?? {};
  if (!["kept", "broken", "cancelled"].includes(b.outcome))
    throw invalid("Choose kept, broken or cancelled");
  const note = required(b.note, "Outcome note", 500);
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor),
      c = { ...ctx, db, actor };
    const [p] =
      await db`select * from collection_promises where id=${required(b.promiseId, "Promise", 64)}::uuid for update`;
    if (!p) throw notFound("Promise not found");
    await requireCapability(c, "collections.plan", p.org_unit_id);
    await customerFor(c, p.customer_code, manilaDate(ctx.now));
    if (p.status !== "open") {
      if (p.status === b.outcome && p.outcome_note === note)
        return { status: p.status };
      throw conflict("This promise was already settled");
    }
    if (b.outcome === "broken" && dayText(p.promised_on) >= manilaDate(ctx.now))
      throw invalid("A promise is broken only after its promised day");
    await db`update collection_promises set status=${b.outcome},outcome_note=${note},outcome_by=${actor.profileId},outcome_at=now(),updated_at=now() where id=${p.id}`;
    ctx.platform?.publish?.("analytics");
    return { status: b.outcome };
  });
}

/** @param {any} ctx */
export async function receiveCheque(ctx) {
  const b = ctx.body ?? {};
  const key = required(b.idempotencyKey, "Idempotency key", 100),
    number = required(b.chequeNumber, "Cheque number", 40),
    bank = required(b.bank, "Bank", 80),
    amount = minor(b.amountMinor, "Cheque amount"),
    chequeDate = isoDay(b.chequeDate, "Cheque date");
  const request = hash({
    c: b.customerCode,
    number,
    bank,
    amount,
    chequeDate,
    p: b.promiseId ?? null,
    r: b.replacesId ?? null,
  });
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor),
      c = { ...ctx, db, actor };
    await requireCapability(c, "collections.plan");
    await customerFor(c, b.customerCode, manilaDate(ctx.now));
    const [old] =
      await db`select id,request_hash,org_unit_id from cheque_instruments where created_by=${actor.profileId} and client_key=${key}`;
    if (old) {
      await requireCapability(c, "collections.plan", old.org_unit_id);
      if (old.request_hash !== request)
        throw conflict(
          "This key was already used for a different cheque",
          "idempotency_conflict",
        );
      return { id: old.id };
    }
    const today = manilaDate(ctx.now);
    if (chequeDate > plus(today, 180) || chequeDate < plus(today, -180))
      throw invalid("A cheque date is within 180 days of today");
    const { store } = await customerFor(c, b.customerCode, today);
    if (b.promiseId) {
      const [p] =
        await db`select customer_code,status,org_unit_id from collection_promises where id=${b.promiseId}::uuid`;
      if (!p || p.customer_code !== store.customer_code || p.status !== "open")
        throw invalid("Link an open promise of the same customer");
      await requireCapability(c, "collections.plan", p.org_unit_id);
    }
    let replaces = null;
    if (b.replacesId) {
      const [old] =
        await db`select * from cheque_instruments where id=${b.replacesId}::uuid for update`;
      if (
        !old ||
        old.customer_code !== store.customer_code ||
        old.status !== "bounced"
      )
        throw invalid(
          "Only a bounced cheque of the same customer can be replaced",
        );
      await requireCapability(c, "collections.plan", old.org_unit_id);
      replaces = old.id;
    }
    const [dupe] =
      await db`select 1 from cheque_instruments where bank=${bank} and cheque_number=${number}`;
    if (dupe) throw conflict("This bank and cheque number is already recorded");
    const [q] =
      await db`insert into cheque_instruments(org_unit_id,customer_code,cheque_number,bank,amount_minor,cheque_date,received_on,promise_id,replaces_id,created_by,client_key,request_hash)
      values(${store.owner_unit_id},${store.customer_code},${number},${bank},${amount},${chequeDate},${today},${b.promiseId ?? null},${replaces},${actor.profileId},${key},${request}) returning id`;
    await db`insert into cheque_events(cheque_id,kind,on_date,note,actor_id) values(${q.id},'received',${today},${chequeDate > today ? "Post-dated" : null},${actor.profileId})`;
    if (replaces) {
      await db`update cheque_instruments set status='replaced',updated_at=now() where id=${replaces}`;
      await db`insert into cheque_events(cheque_id,kind,on_date,note,actor_id) values(${replaces},'replaced',${today},${"Replaced by " + bank + " " + number},${actor.profileId})`;
    }
    ctx.platform?.publish?.("analytics");
    return { id: q.id };
  });
}

/** @param {any} ctx */
export async function chequeEvent(ctx) {
  const b = ctx.body ?? {};
  if (!["deposited", "cleared", "bounced"].includes(b.kind))
    throw invalid("Record deposited, cleared or bounced");
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor),
      c = { ...ctx, db, actor };
    const [q] =
      await db`select * from cheque_instruments where id=${required(b.chequeId, "Cheque", 64)}::uuid for update`;
    if (!q) throw notFound("Cheque not found");
    await requireCapability(c, "collections.plan", q.org_unit_id);
    await customerFor(c, q.customer_code, manilaDate(ctx.now));
    if (q.status === b.kind) return { status: q.status };
    if (!NEXT[q.status]?.includes(b.kind))
      throw conflict(`A ${q.status} cheque cannot be marked ${b.kind}`);
    const today = manilaDate(ctx.now);
    if (b.kind === "deposited" && dayText(q.cheque_date) > today)
      throw invalid("A post-dated cheque cannot be deposited before its date");
    const note =
      b.kind === "bounced"
        ? required(b.note, "Bounce reason", 300)
        : (b.note ?? null);
    await db`update cheque_instruments set status=${b.kind},updated_at=now() where id=${q.id}`;
    await db`insert into cheque_events(cheque_id,kind,on_date,note,actor_id) values(${q.id},${b.kind},${today},${note},${actor.profileId})`;
    ctx.platform?.publish?.("analytics");
    return { status: b.kind };
  });
}

/** Replace one collector's route for a day. @param {any} ctx */
export async function saveRoute(ctx) {
  const b = ctx.body ?? {};
  const routeDate = isoDay(b.routeDate, "Route day");
  if (!Array.isArray(b.stops) || b.stops.length > 60)
    throw invalid("Plan at most 60 stops");
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor),
      c = { ...ctx, db, actor };
    await requireCapability(c, "collections.plan");
    const today = manilaDate(ctx.now);
    if (routeDate < today || routeDate > plus(today, 14))
      throw invalid("Plan a route for today or the next 14 days");
    const [collector] =
      await db`select p.id,p.role,coalesce(a.org_unit_id,p.org_unit_id) unit from profiles p left join lateral (select org_unit_id from employee_assignments a where a.profile_id=p.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) order by effective_from desc limit 1) a on true
        where p.id=${required(b.collectorProfileId, "Collector", 64)}::uuid and p.status='active' and p.deleted_at is null`;
    if (!collector || !["sales", "manager"].includes(collector.role))
      throw invalid("Choose an active field collector");
    await requireCapability(c, "collections.plan", collector.unit);
    await db`select pg_advisory_xact_lock(hashtextextended(${"collect-route:" + routeDate + ":" + collector.id},0))`;
    const seen = new Set();
    const stops = [];
    for (const [i, s] of b.stops.entries()) {
      if (!REASONS.includes(s?.reason))
        throw invalid("Every stop needs a reason");
      const { store } = await customerFor(c, s.customerCode, today);
      if (seen.has(store.customer_code))
        throw invalid("A customer appears once per route");
      seen.add(store.customer_code);
      stops.push({
        sequence: i + 1,
        code: store.customer_code,
        unit: store.owner_unit_id,
        reason: s.reason,
      });
    }
    await db`delete from collection_route_stops where route_date=${routeDate} and collector_profile_id=${collector.id}`;
    for (const s of stops)
      await db`insert into collection_route_stops(org_unit_id,route_date,collector_profile_id,sequence,customer_code,reason,planned_by) values(${s.unit},${routeDate},${collector.id},${s.sequence},${s.code},${s.reason},${actor.profileId})`;
    ctx.platform?.publish?.("analytics");
    return { stops: stops.length };
  });
}

const dayWordsFormat = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "short",
  day: "numeric",
});
/** `2026-09-28` → `Sep 28, 2026` (a Manila calendar day; anything else passes through). @param {string|null|undefined} day */
export function dayInWords(day) {
  if (!day) return "";
  const text = String(day).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? dayWordsFormat.format(Date.parse(`${text}T12:00:00+08:00`))
    : String(day);
}

/** The promise's "For" text, in words (WEB-062). @param {any[]|undefined} items @param {string|null} ref */
export function itemLabel(items, ref) {
  if (!ref) return null;
  const i = items?.find((x) => x.ref === ref);
  if (!i) return "Open item (since settled in the snapshot)";
  const what = i.documentNumber
    ? `Invoice ${i.documentNumber}`
    : i.invoiceDate
      ? `Invoice of ${dayInWords(i.invoiceDate)}`
      : "Open item";
  return i.dueDate ? `${what}, due ${dayInWords(i.dueDate)}` : what;
}

/** Older name kept for callers/tests (WEB-062). */
export const dayWords = dayInWords;

/** Money → Collections plan: exceptions first, with comparison to the prior 28 days. @param {any} ctx */
export async function readCollections(ctx) {
  const s = await scopeFor(ctx);
  const today = manilaDate(ctx.now);
  const routeDate = ctx.url.searchParams.get("date") ?? today;
  isoDay(routeDate, "Route day");
  const ids = s.ids.length ? s.ids : [null];
  const db = ctx.db;
  const stores =
    await db`select distinct on (s.customer_code) s.customer_code,s.name,s.territory_name,s.owner_unit_id from analytics_store_scope s
      where s.customer_code is not null and s.owner_unit_id in ${db(ids)} and s.status='active'
      and (${s.ownProfileId}::uuid is null or exists(select 1 from territory_salespeople ts where ts.territory_id=s.territory_id and ts.profile_id=${s.ownProfileId} and ts.deleted_at is null and ts.effective_from<=now() and (ts.effective_to is null or ts.effective_to>now())))
      order by s.customer_code,s.id limit 5001`;
  if (stores.length > 5000)
    throw conflict("More than 5,000 customers in scope; narrow the team");
  const codes = stores.map((/** @type {any} */ r) => r.customer_code);
  const ar = await latestAr(db, codes, today);
  const promises = codes.length
    ? await db`select p.*,pr.name created_name from collection_promises p join profiles pr on pr.id=p.created_by where p.customer_code in ${db(codes)} and p.org_unit_id in ${db(ids)} and (p.status='open' or p.updated_at>now()-interval '56 days') order by p.promised_on,p.id limit 5000`
    : [];
  const cheques = codes.length
    ? await db`select * from cheque_instruments where customer_code in ${db(codes)} and org_unit_id in ${db(ids)} and (status in ('received','deposited','bounced') or updated_at>now()-interval '56 days') order by cheque_date,id limit 5000`
    : [];
  const routes =
    await db`select r.*,p.name collector_name from collection_route_stops r join profiles p on p.id=r.collector_profile_id where r.route_date=${routeDate} and r.org_unit_id in ${db(ids)} order by p.name,r.sequence`;
  const collectors =
    await db`select p.id,p.name from profiles p where p.status='active' and p.deleted_at is null and p.role in ('sales','manager') and p.org_unit_id in ${db(ids)} and (${s.ownProfileId}::uuid is null or p.id=${s.ownProfileId}) order by p.name limit 500`;
  const name = new Map(
    stores.map((/** @type {any} */ r) => [r.customer_code, r]),
  );
  const weekEnd = plus(today, 6);
  const last28 = Date.now() - 28 * DAY,
    prior28 = Date.now() - 56 * DAY;
  const settled = (
    /** @type {string} */ st,
    /** @type {number} */ from,
    /** @type {number} */ to,
  ) =>
    promises.filter(
      (/** @type {any} */ p) =>
        p.status === st &&
        p.outcome_at &&
        +new Date(p.outcome_at) >= from &&
        +new Date(p.outcome_at) < to,
    ).length;
  const open = promises.filter((/** @type {any} */ p) => p.status === "open");
  /** @type {any[]} */ const actions = [];
  for (const p of open)
    if (dayText(p.promised_on) < today)
      actions.push({
        kind: "promise_overdue",
        customerCode: p.customer_code,
        name: name.get(p.customer_code)?.name,
        amountMinor: Number(p.amount_minor),
        on: dayText(p.promised_on),
        id: p.id,
        next: "Visit or call; mark the promise kept or broken.",
      });
  for (const q of cheques) {
    if (q.status === "bounced")
      actions.push({
        kind: "cheque_replacement",
        customerCode: q.customer_code,
        name: name.get(q.customer_code)?.name,
        amountMinor: Number(q.amount_minor),
        on: dayText(q.cheque_date),
        id: q.id,
        next: "Collect a replacement cheque or cash.",
      });
    else if (q.status === "received" && dayText(q.cheque_date) <= today)
      actions.push({
        kind: "cheque_deposit",
        customerCode: q.customer_code,
        name: name.get(q.customer_code)?.name,
        amountMinor: Number(q.amount_minor),
        on: dayText(q.cheque_date),
        id: q.id,
        next: "The cheque date has come: deposit it.",
      });
  }
  const promised = new Set(open.map((/** @type {any} */ p) => p.customer_code));
  for (const [code, a] of ar)
    if (a.over60Minor > 0 && !promised.has(code))
      actions.push({
        kind: "overdue_balance",
        customerCode: code,
        name: name.get(code)?.name,
        amountMinor: a.over60Minor,
        on: a.asOfDate,
        id: code,
        next: "Over 60 days with no promise: plan a collection visit.",
      });
  const rank = {
    cheque_replacement: 0,
    promise_overdue: 1,
    cheque_deposit: 2,
    overdue_balance: 3,
  };
  actions.sort(
    (x, y) =>
      /** @type {any} */ (rank)[x.kind] - /** @type {any} */ (rank)[y.kind] ||
      y.amountMinor - x.amountMinor,
  );
  const customers = [...ar.entries()]
    .filter(([, a]) => a.totalMinor > 0)
    .map(([code, a]) => ({
      customerCode: code,
      name: name.get(code)?.name ?? code,
      territory: name.get(code)?.territory_name ?? null,
      arMinor: a.totalMinor,
      overdueMinor: a.overdueMinor,
      asOfDate: a.asOfDate,
      openItems: a.items,
      source: a.source ?? SOURCE,
      freshness: a.freshness ?? "sample",
      promisedMinor: open
        .filter((/** @type {any} */ p) => p.customer_code === code)
        .reduce(
          (/** @type {number} */ n, /** @type {any} */ p) =>
            n + Number(p.amount_minor),
          0,
        ),
    }))
    .sort(
      (x, y) =>
        y.overdueMinor - x.overdueMinor ||
        x.customerCode.localeCompare(y.customerCode),
    );
  const total = (/** @type {any[]} */ r, /** @type {string} */ k) =>
    r.reduce((n, x) => n + Number(x[k]), 0);
  const role = ctx.actor?.role;
  return {
    asOf: today,
    source:
      (await sapCollectionItems(db, [], Date.now())) === null
        ? SOURCE
        : "SAP replicated open items (SAMPLE if labelled). Cached, not a live balance; missing items are not zero.",
    routeDate,
    canPlan: !!role && roleHas(role, "collections.plan"),
    summary: {
      arMinor: codes.some((/** @type {string} */ code) => !ar.has(code))
        ? null
        : total(customers, "arMinor"),
      overdueMinor: codes.some((/** @type {string} */ code) => !ar.has(code))
        ? null
        : total(customers, "overdueMinor"),
      openPromisesMinor: total(open, "amount_minor"),
      dueThisWeekMinor: total(
        open.filter(
          (/** @type {any} */ p) =>
            dayText(p.promised_on) >= today &&
            dayText(p.promised_on) <= weekEnd,
        ),
        "amount_minor",
      ),
      overduePromises: open.filter(
        (/** @type {any} */ p) => dayText(p.promised_on) < today,
      ).length,
      keptLast28: settled("kept", last28, Date.now() + 1),
      brokenLast28: settled("broken", last28, Date.now() + 1),
      keptPrior28: settled("kept", prior28, last28),
      brokenPrior28: settled("broken", prior28, last28),
      postDatedMinor: total(
        cheques.filter(
          (/** @type {any} */ q) =>
            q.status === "received" && dayText(q.cheque_date) > today,
        ),
        "amount_minor",
      ),
      bouncedOpen: cheques.filter(
        (/** @type {any} */ q) => q.status === "bounced",
      ).length,
    },
    actions: actions.slice(0, 200),
    actionsTotal: actions.length,
    customers: customers.slice(0, 300),
    customersTotal: customers.length,
    promises: promises.map((/** @type {any} */ p) => ({
      id: p.id,
      customerCode: p.customer_code,
      name: name.get(p.customer_code)?.name ?? p.customer_code,
      openItemRef: p.open_item_ref,
      // Never show the raw SAP/order key: describe the open item by its invoice and due days.
      openItemLabel: itemLabel(ar.get(p.customer_code)?.items, p.open_item_ref),
      amountMinor: Number(p.amount_minor),
      promisedOn: dayText(p.promised_on),
      status: p.status,
      overdue: p.status === "open" && dayText(p.promised_on) < today,
      note: p.note,
      outcomeNote: p.outcome_note,
      createdBy: p.created_name,
    })),
    cheques: cheques.map((/** @type {any} */ q) => ({
      id: q.id,
      customerCode: q.customer_code,
      name: name.get(q.customer_code)?.name ?? q.customer_code,
      chequeNumber: q.cheque_number,
      bank: q.bank,
      amountMinor: Number(q.amount_minor),
      chequeDate: dayText(q.cheque_date),
      postDated: dayText(q.cheque_date) > today,
      status: q.status,
      replacesId: q.replaces_id,
    })),
    routes: Object.values(
      routes.reduce((/** @type {any} */ m, /** @type {any} */ r) => {
        (m[r.collector_profile_id] ??= {
          collectorId: r.collector_profile_id,
          collector: r.collector_name,
          stops: [],
        }).stops.push({
          sequence: r.sequence,
          customerCode: r.customer_code,
          name: name.get(r.customer_code)?.name ?? r.customer_code,
          reason: r.reason,
        });
        return m;
      }, {}),
    ),
    collectors: collectors.map((/** @type {any} */ p) => ({
      id: p.id,
      name: p.name,
    })),
  };
}

/** @param {any} router */
export function installCollections(router) {
  router.get("/api/v1/money/collections", (/** @type {any} */ c) =>
    readCollections(c),
  );
  router.post("/api/v1/money/collections/promise", (/** @type {any} */ c) =>
    createPromise(c),
  );
  router.post(
    "/api/v1/money/collections/promise/settle",
    (/** @type {any} */ c) => settlePromise(c),
  );
  router.post("/api/v1/money/collections/cheque", (/** @type {any} */ c) =>
    receiveCheque(c),
  );
  router.post(
    "/api/v1/money/collections/cheque/event",
    (/** @type {any} */ c) => chequeEvent(c),
  );
  router.post("/api/v1/money/collections/route", (/** @type {any} */ c) =>
    saveRoute(c),
  );
}
