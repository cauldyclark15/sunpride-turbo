import { tx } from "@sunpride/db/client";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { scopeFor, monthEnd, prorate, dates } from "./measures.js";
import { enqueueRefresh } from "./refresh.js";

export const LEVELS = ["company", "channel", "territory", "agent"];
/** @param {any} month */
export function checkMonth(month) {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new ApiError("invalid_month", 400, "Use a YYYY-MM month");
  return month;
}
/** All target subjects, server scoped. @param {any} db @param {any} s */
export async function subjects(db, s) {
  const ids = s.ids.length ? s.ids : [null];
  const [people, territories, channels] = await Promise.all([
    db`select id::text as key,name as label,channel_scope as channel,current_unit_id as unit_id from analytics_people where status='active' and current_unit_id in ${db(ids)} and (${s.ownProfileId}::uuid is null or id=${s.ownProfileId})`,
    db`select t.id::text as key,t.name as label,t.channel,o.org_unit_id as unit_id from territories t join territory_ownerships o on o.territory_id=t.id where t.deleted_at is null and o.deleted_at is null and o.effective_from<=now() and (o.effective_to is null or o.effective_to>now()) and o.org_unit_id in ${db(ids)}`,
    db`select distinct channel as key,channel as label from analytics_store_scope where owner_unit_id in ${db(ids)} and channel is not null`,
  ]);
  return {
    company: [{ key: "company", label: "Company" }],
    channel: channels,
    territory: territories,
    agent: people,
  };
}
/** @param {any} db @param {any} s @param {string} month */
export async function targetBook(db, s, month) {
  s.targetBooks ??= new Map();
  if (!s.targetBooks.has(month))
    s.targetBooks.set(month, buildTargetBook(db, s, month));
  return s.targetBooks.get(month);
}
/** Request-local memoization only: writes and new requests always see committed revisions. @param {any} db @param {any} s @param {string} month */
async function buildTargetBook(db, s, month) {
  const sub = await subjects(db, s);
  const records = await db`select id,created_by,revision_at,
    coalesce(level,case subject_kind when 'employee' then 'agent' when 'territory' then 'territory' end) as level,
    coalesce(target_key,profile_id::text,territory_id::text) as target_key,
    coalesce(amount_centavos,round(value*100)::bigint) as amount_centavos
    from sales_targets where deleted_at is null and metric='sales_value' and period='monthly'
    and (month=${month} or (month is null and effective_from<${new Date(Date.parse(monthEnd(month) + "T00:00:00+08:00") + 86400000)} and (effective_to is null or effective_to>${month + "-01T00:00:00+08:00"}))) order by (sales_targets.level is not null),effective_from`;
  /** @type {Map<string,any>} */ const explicit = new Map(
    records.map((/** @type {any} */ r) => [`${r.level}:${r.target_key}`, r]),
  );
  /** @param {string} level @param {string} key @returns {number|null} */
  function amount(level, key) {
    const own = explicit.get(`${level}:${key}`);
    if (own && ((level !== "company" && level !== "channel") || s.cross))
      return Number(own.amount_centavos);
    /** @type {(number|null)[]} */ let children = [];
    if (level === "company") {
      // One hierarchy, never sum levels together: channel -> territory -> agent.
      children = sub.channel.map((/** @type {any} */ c) =>
        amount("channel", c.key),
      );
      if (!children.length)
        children = sub.agent.map((/** @type {any} */ a) =>
          amount("agent", a.key),
        );
    } else if (level === "channel") {
      const ts = sub.territory.filter(
        (/** @type {any} */ t) => t.channel === key,
      );
      children = ts.length
        ? ts.map((/** @type {any} */ t) => amount("territory", t.key))
        : sub.agent
            .filter((/** @type {any} */ a) => a.channel === key)
            .map((/** @type {any} */ a) => amount("agent", a.key));
    } else if (level === "territory") {
      const territory = sub.territory.find(
        (/** @type {any} */ t) => t.key === key,
      );
      children = sub.agent
        .filter(
          (/** @type {any} */ a) =>
            a.unit_id === territory?.unit_id &&
            (!territory.channel || a.channel === territory.channel),
        )
        .map((/** @type {any} */ a) => amount("agent", a.key));
    }
    const known = children.filter((n) => n !== null);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  }
  return { sub, explicit, amount };
}
/** @param {any} db @param {any} s @param {any} p @param {string} [level] @param {string} [key] */
export async function targetFor(db, s, p, level = "company", key = "company") {
  let amount = 0,
    known = false;
  const months = [...new Set(dates(p.from, p.to).map((d) => d.slice(0, 7)))];
  for (const month of months) {
    const book = await targetBook(db, s, month),
      value = book.amount(level, key);
    if (value !== null) {
      known = true;
      amount += prorate(value, month, p.from, p.to);
    }
  }
  return known ? amount : null;
}
/** @param {any} ctx */
export async function listTargets(ctx) {
  const s = await scopeFor(ctx),
    q = ctx.url.searchParams;
  const month = checkMonth(q.get("month")),
    level = q.get("level") ?? "agent";
  if (!LEVELS.includes(level))
    throw new ApiError("invalid_level", 400, "Choose a target level");
  const book = await targetBook(ctx.db, s, month);
  const rows = book.sub[/** @type {keyof typeof book.sub} */ (level)].map(
    (/** @type {any} */ sub) => {
      const own = book.explicit.get(`${level}:${sub.key}`);
      const amount = book.amount(level, sub.key);
      return {
        key: sub.key,
        label: sub.label,
        amountCentavos: amount,
        setBy:
          own && (s.cross || !["company", "channel"].includes(level))
            ? own.created_by
            : null,
        setAt:
          own && (s.cross || !["company", "channel"].includes(level))
            ? new Date(own.revision_at).getTime()
            : null,
      };
    },
  );
  return {
    month,
    level,
    rows,
    total: rows.some((/** @type {any} */ r) => r.amountCentavos != null)
      ? rows.reduce(
          (/** @type {number} */ a, /** @type {any} */ r) =>
            a + (r.amountCentavos ?? 0),
          0,
        )
      : null,
  };
}
/** @param {any} db @param {any} s @param {any} row */
async function validateRow(db, s, row) {
  if (
    !row ||
    !LEVELS.includes(row.level) ||
    typeof row.key !== "string" ||
    !Number.isSafeInteger(row.amountCentavos) ||
    row.amountCentavos < 0 ||
    row.amountCentavos > 9_999_999_999_999
  )
    return "A level, key and nonnegative integer centavos are required";
  const sub = await subjects(db, s);
  if (
    !sub[/** @type {keyof typeof sub} */ (row.level)].some(
      (/** @type {any} */ r) => r.key === row.key,
    )
  )
    return "The target is outside your team";
  if (["company", "channel"].includes(row.level) && !s.cross) {
    // A root-scoped administrator may manage the full company/channel, a regional one may not.
    const outside =
      await db`select count(*) as n from org_units where deleted_at is null and status='active' and id not in ${db(s.ids.length ? s.ids : [null])}`;
    if (Number(outside[0].n) > 0)
      return "Only a company-wide manager can set this target";
  }
  return null;
}
/** @param {any} ctx @param {any} t @param {string} month @param {any} row */
async function writeTarget(ctx, t, month, row) {
  await t`select pg_advisory_xact_lock(hashtext(${`target:${month}:${row.level}:${row.key}`}))`;
  const [previous] =
    await t`select * from sales_targets where month=${month} and level=${row.level} and target_key=${row.key} and deleted_at is null for update`;
  if (previous)
    await t`update sales_targets set deleted_at=${new Date(ctx.now)} where id=${previous.id}`;
  const subject = {
    company: "company",
    channel: "channel",
    territory: "territory",
    agent: "employee",
  }[/** @type {'company'|'channel'|'territory'|'agent'} */ (row.level)];
  const [unit] =
    await t`select organization_id from org_units where id=${ctx.actor.orgUnitId}`;
  const org =
    unit?.organization_id ??
    (await t`select organization_id from org_units limit 1`)[0]
      ?.organization_id;
  const [record] =
    await t`insert into sales_targets(organization_id,subject_kind,profile_id,territory_id,period,metric,value,effective_from,effective_to,source_ref,created_by,month,level,target_key,amount_centavos,revision_at)
    values(${org},${subject},${row.level === "agent" ? row.key : null},${row.level === "territory" ? row.key : null},'monthly','sales_value',${row.amountCentavos / 100},${month + "-01T00:00:00+08:00"},${new Date(Date.parse(monthEnd(month) + "T00:00:00+08:00") + 86400000)},'management-v2',${ctx.actor.userId},${month},${row.level},${row.key},${row.amountCentavos},${new Date(ctx.now)}) returning id`;
  await t`insert into analytics_target_events(target_id,actor_profile_id,actor_user_id,before_value,after_value,occurred_at) values(${record.id},${ctx.actor.profileId},${ctx.actor.userId},${previous ?? null},${row},${new Date(ctx.now)})`;
  return record.id;
}
/** @param {any} ctx @param {boolean} [bulk] @param {any} [installCtx] */
export async function setTargets(ctx, bulk = false, installCtx = null) {
  await requireCapability(ctx, "target.manage");
  const s = await scopeFor(ctx),
    month = checkMonth(ctx.body?.month);
  const rows = bulk ? ctx.body?.rows : [ctx.body];
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000)
    throw new ApiError("invalid_rows", 400, "Supply one to 1000 target rows");
  const result = await tx(ctx.db, async (t) => {
    // Validation and writes share one transaction and re-check capability/scope.
    await requireCapability({ ...ctx, db: t }, "target.manage");
    const currentScope = await scopeFor({ ...ctx, db: t });
    const errors = [],
      seen = new Set();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i],
        key = `${r?.level}:${r?.key}`;
      const message = seen.has(key)
        ? "Duplicate target in this import"
        : await validateRow(t, currentScope, r);
      seen.add(key);
      if (message) errors.push({ row: i + 1, message });
    }
    if (errors.length) return { applied: 0, errors, ids: [] };
    const ids = [];
    for (const row of [...rows].sort((a, b) =>
      `${a.level}:${a.key}`.localeCompare(`${b.level}:${b.key}`),
    )) {
      const id = await writeTarget(ctx, t, month, row);
      ids.push(id);
      if (installCtx?.recordChange)
        await installCtx.recordChange(t, {
          entity: "sales_targets",
          entityId: id,
          scopeKey: currentScope.unitId ?? "company",
          op: "upsert",
        });
    }
    return { applied: ids.length, errors: [], ids };
  });
  if (result.applied)
    await enqueueRefresh(ctx, {
      kind: "target",
      date: month + "-01",
      unitId: s.unitId,
    });
  return result;
}
