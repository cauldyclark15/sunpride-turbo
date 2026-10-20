// F-615: target setting and cascade. One parent's monthly target is allocated to its complete set of
// children (company -> channel -> territory -> agent, the same hierarchy the target book rolls up),
// reconciled exactly, submitted, and published only by a different approver. Publishing sales_value
// writes the existing sales_targets rows, so the cockpit, Sales & targets and pace read one book.
import { tx } from "@sunpride/db/client";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { requireCapability, roleHas } from "../../core/capabilities.js";
import { invalid, conflict, notFound, forbidden } from "../../core/errors.js";
import { currentActor } from "../van/access.js";
import { scopeFor, monthEnd } from "../analytics/measures.js";
import { subjects, checkMonth, writeTarget } from "../analytics/targets.js";
import { enqueueRefresh } from "../analytics/refresh.js";
import { required } from "../org/model.js";

/** Metric catalogue: unit, whether children sum to the parent, and how a basis is measured. */
export const METRICS = {
  sales_value: { label: "Sales value", unit: "centavos", additive: true },
  // SEAM(MASTERS): order quantity in the ordered UOM until governed base-UOM conversion is published.
  volume: { label: "Sales volume", unit: "order quantity", additive: true },
  coverage_stores: { label: "Buying stores", unit: "stores", additive: true },
  distribution_points: {
    label: "Distribution points",
    unit: "store-SKU points",
    additive: true,
  },
  calls: { label: "Calls", unit: "calls", additive: true },
  // A rate: every child carries a rate; children are never summed to the parent.
  msl_compliance: {
    label: "MSL compliance",
    unit: "basis points",
    additive: false,
  },
};
const BASIS_SQL = {
  sales_value: "sum(sales_centavos)",
  volume: "sum(quantity)",
  coverage_stores: "count(distinct store_id)",
  distribution_points: "count(distinct (store_id::text||':'||product_code))",
};
const hash = (/** @type {any} */ v) => sha256Hex(canonicalJson(v));
/** @param {string} m @param {number} n */
const shift = (m, n) => {
  const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

/** The complete child set of one parent, from the caller's current scoped subjects.
 * @param {any} sub @param {string} level @param {string} key */
export function childrenOf(sub, level, key) {
  if (level === "company")
    return sub.channel.length
      ? { level: "channel", rows: sub.channel }
      : { level: "agent", rows: sub.agent };
  if (level === "channel") {
    const ts = sub.territory.filter(
      (/** @type {any} */ t) => t.channel === key,
    );
    return ts.length
      ? { level: "territory", rows: ts }
      : {
          level: "agent",
          rows: sub.agent.filter((/** @type {any} */ a) => a.channel === key),
        };
  }
  if (level === "territory") {
    const t = sub.territory.find((/** @type {any} */ r) => r.key === key);
    return {
      level: "agent",
      rows: t
        ? sub.agent.filter(
            (/** @type {any} */ a) =>
              a.unit_id === t.unit_id &&
              (!t.channel || a.channel === t.channel),
          )
        : [],
    };
  }
  throw invalid("Agents have no children to cascade to");
}

/** Largest-remainder allocation: integer amounts that sum exactly to the parent.
 * @param {number} total @param {{key:string,basis:number|null}[]} rows */
export function allocate(total, rows) {
  if (!rows.length) return [];
  const weights = rows.map((r) => Math.max(0, Number(r.basis ?? 0)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : rows.map(() => 1),
    W = sum > 0 ? sum : rows.length;
  const raw = w.map((x) => (total * x) / W);
  const out = raw.map((x) => Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x), key: rows[i].key }))
    .sort((a, b) => b.frac - a.frac || a.key.localeCompare(b.key));
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--)
    out[order[k].i]++;
  return out;
}

/** @param {any} db @param {any} s @param {string} level @param {string} key */
async function requireParent(db, s, level, key) {
  const sub = await subjects(db, s);
  const parent = sub[/** @type {keyof typeof sub} */ (level)]?.find(
    (/** @type {any} */ r) => r.key === key,
  );
  if (!parent) throw forbidden("This target is outside your team");
  if (["company", "channel"].includes(level) && !s.cross) {
    const [o] =
      await db`select count(*)::int n from org_units where deleted_at is null and status='active' and id not in ${db(s.ids.length ? s.ids : [null])}`;
    if (o.n > 0)
      throw forbidden("Only a company-wide manager can cascade this target");
  }
  return { sub, parent };
}

/** @param {any} body */
function readIdentity(body) {
  const month = checkMonth(body?.month),
    metric = body?.metric;
  if (!Object.hasOwn(METRICS, metric)) throw invalid("Choose a target metric");
  const productCode =
    metric === "volume" ? required(body.productCode, "Product code", 60) : null;
  if (metric !== "volume" && body?.productCode)
    throw invalid("Only a volume target names a product");
  const parentLevel = body?.parentLevel;
  if (!["company", "channel", "territory"].includes(parentLevel))
    throw invalid("Choose the parent level");
  const parentKey = required(body.parentKey, "Parent", 100);
  const parentAmount = body?.parentAmount;
  if (
    !Number.isSafeInteger(parentAmount) ||
    parentAmount < 0 ||
    parentAmount > 9_999_999_999_999 ||
    (metric === "msl_compliance" && parentAmount > 10000)
  )
    throw invalid(
      metric === "msl_compliance"
        ? "Enter a rate from 0 to 10000 basis points"
        : "Enter a nonnegative whole-number target",
    );
  return { month, metric, productCode, parentLevel, parentKey, parentAmount };
}

/** Prior three complete months, measured with the shared analytics sales facts.
 * @param {any} db @param {string} metric @param {string|null} product @param {string} childLevel @param {string[]} keys @param {string} month */
async function basisFor(db, metric, product, childLevel, keys, month) {
  const from = shift(month, -3) + "-01",
    to = monthEnd(shift(month, -1));
  if (!Object.hasOwn(BASIS_SQL, metric) || !keys.length)
    return { from: null, to: null, values: new Map() };
  const group =
    childLevel === "channel"
      ? "channel"
      : childLevel === "territory"
        ? "territory_id::text"
        : "profile_id::text";
  // Both fragments come from the fixed maps above, never from request input.
  const rows =
    await db`select ${db.unsafe(group)} as key, ${db.unsafe(BASIS_SQL[/** @type {keyof typeof BASIS_SQL} */ (metric)])} as v from analytics_sales_facts
     where approved and service_date between ${from}::date and ${to}::date and ${db.unsafe(group)} in ${db(keys)} and (${product}::text is null or product_code=${product})
     group by 1`;
  return {
    from,
    to,
    values: new Map(
      rows.map((/** @type {any} */ r) => [r.key, Math.round(Number(r.v))]),
    ),
  };
}

/** @param {any} db @param {any} s @param {any} id @param {string} [requested] */
async function draft(db, s, id, requested) {
  const { sub, parent } = await requireParent(
    db,
    s,
    id.parentLevel,
    id.parentKey,
  );
  const kids = childrenOf(sub, id.parentLevel, id.parentKey);
  if (!kids.rows.length)
    throw conflict("This parent has no children in your team to cascade to");
  const def = METRICS[/** @type {keyof typeof METRICS} */ (id.metric)];
  const basis = await basisFor(
    db,
    id.metric,
    id.productCode,
    kids.level,
    kids.rows.map((/** @type {any} */ r) => r.key),
    id.month,
  );
  const method = !def.additive
    ? "same_rate"
    : requested === "equal" || !basis.from
      ? "equal"
      : [...basis.values.values()].some((v) => v > 0)
        ? "prior_actual"
        : "equal";
  /** @type {{key:string,label:string,basis:number|null}[]} */
  const rows = kids.rows
    .map((/** @type {any} */ r) => ({
      key: String(r.key),
      label: r.label,
      basis: basis.from ? (basis.values.get(String(r.key)) ?? 0) : null,
    }))
    .sort((/** @type {any} */ a, /** @type {any} */ b) =>
      a.key.localeCompare(b.key),
    );
  const amounts =
    method === "same_rate"
      ? rows.map(() => id.parentAmount)
      : allocate(
          id.parentAmount,
          rows.map((r) => ({
            key: r.key,
            basis: method === "equal" ? 1 : r.basis,
          })),
        );
  return {
    parentLabel: parent.label,
    childLevel: kids.level,
    method,
    basisFrom: method === "prior_actual" ? basis.from : null,
    basisTo: method === "prior_actual" ? basis.to : null,
    unit: def.unit,
    additive: def.additive,
    lines: rows.map((r, i) => ({ ...r, amount: amounts[i] })),
  };
}

/** Reconciliation of proposed lines against the current complete child set.
 * @param {any} d @param {number} parentAmount @param {any[]} lines */
export function reconcile(d, parentAmount, lines) {
  const expected = new Set(d.lines.map((/** @type {any} */ l) => l.key));
  const given = new Map();
  for (const l of lines) {
    if (!l || typeof l.key !== "string" || given.has(l.key))
      return { ok: false, message: "Each child appears exactly once" };
    if (!Number.isSafeInteger(l.amount) || l.amount < 0)
      return {
        ok: false,
        message: "Child targets are nonnegative whole numbers",
      };
    if (!d.additive && l.amount > 10000)
      return { ok: false, message: "A rate is at most 10000 basis points" };
    given.set(l.key, l.amount);
  }
  const missing = [...expected].filter((k) => !given.has(k)),
    extra = [...given.keys()].filter((k) => !expected.has(k));
  if (missing.length || extra.length)
    return {
      ok: false,
      message: "The team changed: preview the cascade again",
      missing,
      extra,
    };
  const allocated = [...given.values()].reduce((a, b) => a + b, 0);
  if (d.additive && allocated !== parentAmount)
    return {
      ok: false,
      message: `Children total ${allocated}, parent is ${parentAmount}: difference ${parentAmount - allocated}`,
      allocated,
    };
  return { ok: true, allocated };
}

/** @param {any} ctx */
export async function previewCascade(ctx) {
  await requireCapability(ctx, "target.manage");
  const id = readIdentity(ctx.body);
  const s = await scopeFor(ctx);
  const d = await draft(ctx.db, s, id, ctx.body?.method);
  return {
    ...id,
    ...d,
    reconciliation: reconcile(d, id.parentAmount, d.lines),
  };
}

/** @param {any} ctx */
export async function submitCascade(ctx) {
  const id = readIdentity(ctx.body);
  const key = required(ctx.body?.idempotencyKey, "Idempotency key", 100),
    sourceRef = required(ctx.body?.sourceRef, "Source or assumption", 300);
  const lines = Array.isArray(ctx.body?.lines) ? ctx.body.lines : [];
  if (!lines.length || lines.length > 1000)
    throw invalid("Supply one to 1000 child targets");
  const request = hash({
    ...id,
    sourceRef,
    lines,
    method: ctx.body?.method ?? null,
  });
  return tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor),
      c = { ...ctx, db, actor };
    await requireCapability(c, "target.manage");
    const [old] =
      await db`select id,status,version,content_hash,request_hash from target_cascades where prepared_by=${actor.profileId} and client_key=${key}`;
    if (old) {
      if (old.request_hash !== request)
        throw conflict(
          "This key was already used for a different cascade",
          "idempotency_conflict",
        );
      return {
        id: old.id,
        version: old.version,
        status: old.status,
        contentHash: old.content_hash,
      };
    }
    const s = await scopeFor(c);
    await db`select pg_advisory_xact_lock(hashtextextended(${`cascade:${id.month}:${id.metric}:${id.productCode ?? ""}:${id.parentLevel}:${id.parentKey}`},0))`;
    const d = await draft(db, s, id, ctx.body?.method);
    const r = reconcile(d, id.parentAmount, lines);
    if (!r.ok) throw conflict(r.message, "cascade_unreconciled");
    const byKey = new Map(d.lines.map((/** @type {any} */ l) => [l.key, l]));
    const final = lines
      .map((/** @type {any} */ l) => ({
        key: l.key,
        label: byKey.get(l.key).label,
        basis: byKey.get(l.key).basis,
        amount: l.amount,
      }))
      .sort((/** @type {any} */ a, /** @type {any} */ b) =>
        a.key.localeCompare(b.key),
      );
    const manual = final.some(
      (/** @type {any} */ l) => l.amount !== byKey.get(l.key).amount,
    );
    const method = manual && d.additive ? "manual" : d.method;
    const contentHash = hash({
      ...id,
      childLevel: d.childLevel,
      method,
      lines: final.map((/** @type {any} */ l) => [l.key, l.amount]),
    });
    const [{ v }] =
      await db`select coalesce(max(version),0)+1 as v from target_cascades where month=${id.month} and metric=${id.metric} and coalesce(product_code,'')=${id.productCode ?? ""} and parent_level=${id.parentLevel} and parent_key=${id.parentKey}`;
    const [row] =
      await db`insert into target_cascades(month,metric,product_code,unit,parent_level,parent_key,parent_label,child_level,parent_amount,method,basis_from,basis_to,version,status,source_ref,content_hash,prepared_by,client_key,request_hash)
      values(${id.month},${id.metric},${id.productCode},${d.unit},${id.parentLevel},${id.parentKey},${d.parentLabel},${d.childLevel},${id.parentAmount},${method},${method === "prior_actual" ? d.basisFrom : null},${method === "prior_actual" ? d.basisTo : null},${v},'submitted',${sourceRef},${contentHash},${actor.profileId},${key},${request}) returning id`;
    for (const l of final)
      await db`insert into target_cascade_lines(cascade_id,child_key,child_label,basis,amount) values(${row.id},${l.key},${l.label},${l.basis},${l.amount})`;
    await db`insert into target_cascade_events(cascade_id,kind,actor_id,detail) values(${row.id},'submitted',${actor.profileId},${{ contentHash }})`;
    ctx.platform?.publish?.("analytics");
    return { id: row.id, version: v, status: "submitted", contentHash };
  });
}

/** @param {any} ctx @param {any} [installCtx] */
export async function decideCascade(ctx, installCtx = null) {
  const decision = ctx.body?.decision;
  if (!["approve", "reject"].includes(decision))
    throw invalid("Approve or reject");
  const reason =
    decision === "reject"
      ? required(ctx.body?.reason, "Reason", 500)
      : (ctx.body?.reason ?? null);
  const result = await tx(ctx.db, async (db) => {
    const actor = await currentActor(db, ctx.actor),
      c = { ...ctx, db, actor };
    await requireCapability(c, "target.approve");
    const [k] =
      await db`select * from target_cascades where id=${required(ctx.body?.cascadeId, "Cascade", 64)}::uuid for update`;
    if (!k) throw notFound("Cascade not found");
    const s = await scopeFor(c);
    await requireParent(db, s, k.parent_level, k.parent_key);
    if (k.prepared_by === actor.profileId)
      throw forbidden("A different person must approve this cascade");
    if (k.status !== "submitted")
      throw conflict("This cascade was already decided");
    if (ctx.body?.contentHash !== k.content_hash)
      throw conflict(
        "The cascade changed since you opened it",
        "stale_cascade",
      );
    const lines =
      await db`select child_key as key,amount::bigint as amount from target_cascade_lines where cascade_id=${k.id} order by child_key`;
    if (decision === "reject") {
      await db`update target_cascades set status='rejected',decided_by=${actor.profileId},decided_at=now(),decision_reason=${reason},updated_at=now() where id=${k.id}`;
      await db`insert into target_cascade_events(cascade_id,kind,actor_id,detail) values(${k.id},'rejected',${actor.profileId},${{ reason }})`;
      return { status: "rejected", month: k.month, metric: k.metric, s };
    }
    // The team may have changed since submission: re-reconcile against today's child set.
    const d = await draft(
      db,
      s,
      {
        month: k.month,
        metric: k.metric,
        productCode: k.product_code,
        parentLevel: k.parent_level,
        parentKey: k.parent_key,
        parentAmount: Number(k.parent_amount),
      },
      "equal",
    );
    const r = reconcile(
      d,
      Number(k.parent_amount),
      lines.map((/** @type {any} */ l) => ({
        key: l.key,
        amount: Number(l.amount),
      })),
    );
    if (!r.ok) throw conflict(r.message, "cascade_unreconciled");
    const [newer] =
      await db`select 1 from target_cascades where month=${k.month} and metric=${k.metric} and coalesce(product_code,'')=${k.product_code ?? ""} and parent_level=${k.parent_level} and parent_key=${k.parent_key} and status='published' and version>${k.version}`;
    if (newer)
      throw conflict("A newer version is already published", "stale_cascade");
    // The published version and every older version still waiting are replaced, so a stale
    // earlier submission can never be approved over a newer published book.
    const prior =
      await db`select id from target_cascades where month=${k.month} and metric=${k.metric} and coalesce(product_code,'')=${k.product_code ?? ""} and parent_level=${k.parent_level} and parent_key=${k.parent_key}
        and (status='published' or (status='submitted' and version<${k.version})) for update`;
    for (const p of prior) {
      await db`update target_cascades set status='superseded',updated_at=now() where id=${p.id}`;
      await db`insert into target_cascade_events(cascade_id,kind,actor_id,detail) values(${p.id},'superseded',${actor.profileId},${{ by: k.id }})`;
    }
    await db`update target_cascades set status='published',decided_by=${actor.profileId},decided_at=now(),decision_reason=${reason},updated_at=now() where id=${k.id}`;
    await db`insert into target_cascade_events(cascade_id,kind,actor_id,detail) values(${k.id},'published',${actor.profileId},${{ contentHash: k.content_hash }})`;
    if (k.metric === "sales_value") {
      // One book: publication writes the explicit parent and child monthly sales targets.
      const write = { ...ctx, actor };
      const rows = [
        {
          level: k.parent_level,
          key: k.parent_key,
          amountCentavos: Number(k.parent_amount),
        },
        ...lines.map((/** @type {any} */ l) => ({
          level: k.child_level,
          key: l.key,
          amountCentavos: Number(l.amount),
        })),
      ];
      for (const row of rows) {
        const id = await writeTarget(write, db, k.month, row);
        if (installCtx?.recordChange)
          await installCtx.recordChange(db, {
            entity: "sales_targets",
            entityId: id,
            scopeKey: s.unitId ?? "company",
            op: "upsert",
          });
      }
    }
    return { status: "published", month: k.month, metric: k.metric, s };
  });
  if (result.status === "published" && result.metric === "sales_value")
    await enqueueRefresh(ctx, {
      kind: "target",
      date: result.month + "-01",
      unitId: result.s.unitId,
    });
  ctx.platform?.publish?.("analytics");
  return { status: result.status };
}

/** Sales & targets: cascades whose parent the caller can see, plus the published bundle. @param {any} ctx */
export async function readCascades(ctx) {
  const month = checkMonth(ctx.url.searchParams.get("month"));
  const s = await scopeFor(ctx);
  const sub = await subjects(ctx.db, s);
  const visible = new Set(
    ["company", "channel", "territory"].flatMap((lv) =>
      sub[/** @type {keyof typeof sub} */ (lv)].map(
        (/** @type {any} */ r) => `${lv}:${r.key}`,
      ),
    ),
  );
  const rows =
    await ctx.db`select k.*,pp.name as prepared_name,dp.name as decided_name from target_cascades k
      join profiles pp on pp.id=k.prepared_by left join profiles dp on dp.id=k.decided_by
      where k.month=${month} order by k.metric,k.parent_level,k.parent_key,k.version desc limit 2000`;
  const mine = rows.filter((/** @type {any} */ k) =>
    visible.has(`${k.parent_level}:${k.parent_key}`),
  );
  const lines = mine.length
    ? await ctx.db`select cascade_id,child_key,child_label,basis,amount from target_cascade_lines where cascade_id in ${ctx.db(mine.map((/** @type {any} */ k) => k.id))} order by child_label`
    : [];
  const role = ctx.actor?.role;
  return {
    month,
    metrics: Object.entries(METRICS).map(([key, m]) => ({ key, ...m })),
    parents: {
      company: sub.company,
      channel: sub.channel,
      territory: sub.territory.map((/** @type {any} */ t) => ({
        key: t.key,
        label: t.label,
      })),
    },
    canPrepare: !!role && roleHas(role, "target.manage"),
    canApprove: !!role && roleHas(role, "target.approve"),
    me: ctx.actor?.profileId ?? null,
    cascades: mine.map((/** @type {any} */ k) => ({
      id: k.id,
      metric: k.metric,
      productCode: k.product_code,
      unit: k.unit,
      parentLevel: k.parent_level,
      parentKey: k.parent_key,
      parentLabel: k.parent_label,
      childLevel: k.child_level,
      parentAmount: Number(k.parent_amount),
      method: k.method,
      basisFrom: k.basis_from
        ? String(
            k.basis_from instanceof Date
              ? k.basis_from.toISOString()
              : k.basis_from,
          ).slice(0, 10)
        : null,
      version: k.version,
      status: k.status,
      sourceRef: k.source_ref,
      contentHash: k.content_hash,
      preparedBy: k.prepared_name,
      preparedById: k.prepared_by,
      decidedBy: k.decided_name,
      decisionReason: k.decision_reason,
      lines: lines
        .filter((/** @type {any} */ l) => l.cascade_id === k.id)
        .map((/** @type {any} */ l) => ({
          key: l.child_key,
          label: l.child_label,
          basis: l.basis == null ? null : Number(l.basis),
          amount: Number(l.amount),
        })),
    })),
  };
}

/** @param {any} router @param {any} platform */
export function installTargetCascade(router, platform) {
  router.get("/api/v1/targets/cascade", (/** @type {any} */ c) =>
    readCascades(c),
  );
  router.post("/api/v1/targets/cascade/preview", (/** @type {any} */ c) =>
    previewCascade(c),
  );
  router.post("/api/v1/targets/cascade/submit", (/** @type {any} */ c) =>
    submitCascade(c),
  );
  router.post("/api/v1/targets/cascade/decide", (/** @type {any} */ c) =>
    decideCascade(c, platform),
  );
}
