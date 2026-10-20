import { mslFrameworkRows } from "../masters/definitions.js";
import { requireNationalScope } from "../../core/capabilities.js";
import { conflict, invalid, notFound } from "../../core/errors.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { writeAudit } from "../org/audit.js";
import { accessOutlet, uuid, text } from "../visits/shared.js";
import { ids, quantity, resolveSet, matches } from "./rules.js";

/** SEAM(MASTERS): replace this reader with the F-017 framework reader at integration.
 * Until then, versioned release payloads carry a frozen framework profile; no taxonomy tables are forked.
 * Contract: {id,version,label,payload:{channel,subchannel,classification,priority,outletIds,lines:[{productId,minimumBase}]},sample}.
 * @param {any} db @param {string} kind @param {number} at */
export async function releasesAt(db, kind, at) {
  if (kind === "msl") {
    const framework = await mslFrameworkRows(db, at);
    // Frozen legacy releases remain readable only before canonical framework setup.
    if (framework.length) return framework;
  }
  const rows =
    await db`select * from availability_releases where kind=${kind} and status='published' and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) order by policy_key,version`;
  return kind === "rules" && rows.some((/** @type {any} */ r) => !r.sample)
    ? rows.filter((/** @type {any} */ r) => !r.sample)
    : rows;
}
/** @param {any} db @param {string} id */
export async function outletAt(db, id) {
  const [row] =
    await db`select o.*,a.territory_id,exists(select 1 from sample_data_rows m where m.table_name='outlets' and m.row_id=o.id::text) as is_sample from outlets o left join outlet_assignments a on a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) where o.id=${uuid(id)} and o.deleted_at is null`;
  if (!row) throw notFound("Store not found");
  return row;
}
/** @param {any} ctx */
export async function manage(ctx) {
  await requireNationalScope(ctx, ["super_admin", "admin", "operations"]);
  // A title such as Trade Marketing is never used as a permission.
  return ctx.actor;
}
/** @param {any} ctx @param {string} kind @param {any} input */
async function validatePayload(ctx, kind, input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalid();
  const p = { ...input };
  for (const key of ["channel", "subchannel", "classification"])
    if (p[key] != null) p[key] = text(p[key], 80);
  p.outletIds = ids(p.outletIds ?? [], 1000);
  p.territoryIds = ids(p.territoryIds ?? [], 200);
  for (const id of p.outletIds)
    await accessOutlet(ctx, id, "masterdata.manage");
  for (const id of p.territoryIds) {
    const [t] =
      await ctx.db`select id from territories where id=${id} and organization_id='sunpride' and deleted_at is null`;
    if (!t) throw invalid("Territory unavailable");
  }
  if (["msl", "focus"].includes(kind)) {
    if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 200)
      throw invalid("Choose 1–200 products");
    ids(
      p.lines.map((/** @type {any} */ l) => l.productId),
      200,
    );
    for (const l of p.lines) {
      const [product] =
        await ctx.db`select id from products where id=${l.productId} and active and deleted_at is null and (organization_id is null or organization_id='sunpride')`;
      if (!product) throw invalid("Product unavailable");
    }
    p.lines = p.lines.map((/** @type {any} */ l) => ({
      productId: l.productId,
      minimumBase: quantity(l.minimumBase ?? 1, 1000000) || 1,
      ...(kind === "focus" ? { objective: text(l.objective, 500) } : {}),
    }));
    p.priority = quantity(p.priority ?? 0, 99);
  } else if (kind === "launch") {
    p.productIds = ids(p.productIds, 200);
    if (!p.productIds.length || !p.outletIds.length)
      throw invalid("Launch needs products and target stores");
    for (const id of p.productIds)
      if (
        !(
          await ctx.db`select 1 from products where id=${id} and active and deleted_at is null`
        ).length
      )
        throw invalid("Product unavailable");
    if (
      !Array.isArray(p.buildTargets) ||
      !p.buildTargets.length ||
      p.buildTargets.length > 366
    )
      throw invalid("Add dated build targets");
    let prev = "",
      total = 0;
    p.buildTargets = p.buildTargets.map((/** @type {any} */ t) => {
      if (
        typeof t.date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(t.date) ||
        new Date(t.date).toISOString().slice(0, 10) !== t.date ||
        t.date <= prev
      )
        throw invalid("Build dates must be valid and ascending");
      const outlets = quantity(t.outlets, p.outletIds.length);
      if (outlets < total)
        throw invalid("Cumulative build targets cannot decrease");
      prev = t.date;
      total = outlets;
      return { date: t.date, outlets };
    });
  } else if (kind === "rules") {
    return {
      coverDays: quantity(p.coverDays, 90) || 1,
      freshnessDays: quantity(p.freshnessDays, 90) || 1,
      universeFreshnessDays: quantity(p.universeFreshnessDays, 90) || 1,
    };
  }
  return p;
}
/** F-211/F-216/F-219: append a draft version; published versions never edited in place. @param {any} ctx */
export async function createRelease(ctx) {
  await manage(ctx);
  const p = ctx.body;
  if (
    !["msl", "focus", "launch", "rules"].includes(p.kind) ||
    !Number.isSafeInteger(p.effectiveFrom) ||
    p.effectiveFrom < ctx.now - 1000 ||
    (p.effectiveTo != null &&
      (!Number.isSafeInteger(p.effectiveTo) ||
        p.effectiveTo <= p.effectiveFrom))
  )
    throw invalid("Choose a future effective interval");
  const key = text(p.key, 80),
    label = text(p.label, 160),
    source = text(p.sourceRef, 300);
  if (typeof p.sample !== "boolean")
    throw invalid("Declare whether this is sample data");
  const payload = await validatePayload(ctx, p.kind, p.payload);
  await ctx.db`select pg_advisory_xact_lock(hashtext(${`availability:${p.kind}:${key}`}))`;
  const [v] =
    await ctx.db`select coalesce(max(version),0)+1 as n from availability_releases where kind=${p.kind} and policy_key=${key}`;
  const [row] =
    await ctx.db`insert into availability_releases(kind,policy_key,version,label,status,effective_from,effective_to,payload,source_ref,sample,actor_subject) values (${p.kind},${key},${v.n},${label},'draft',${new Date(p.effectiveFrom)},${p.effectiveTo == null ? null : new Date(p.effectiveTo)},${payload},${source},${p.sample},${ctx.actor.subject}) returning *`;
  if (p.sample)
    await markSample(
      ctx.db,
      "availability_releases",
      row.id,
      `release-${row.id}`,
    );
  await audit(ctx, "availability.draft", row.id);
  return row;
}
/** @param {any} ctx */
export async function preview(ctx) {
  await manage(ctx);
  const p = ctx.body,
    id = uuid(p.releaseId),
    outletIds = ids(p.outletIds ?? [], 1000);
  const [release] =
    await ctx.db`select * from availability_releases where id=${id}`;
  if (!release) throw notFound();
  const at = new Date(release.effective_from).getTime();
  let candidates = await releasesAt(ctx.db, release.kind, at);
  candidates = candidates.filter(
    (/** @type {any} */ r) => r.policy_key !== release.policy_key,
  );
  candidates.push(release);
  const rows = [];
  for (const outletId of outletIds) {
    await accessOutlet(ctx, outletId, "masterdata.manage");
    const outlet = await outletAt(ctx.db, outletId);
    const resolved =
      release.kind === "msl" ? resolveSet(outlet, candidates) : null;
    const applicable =
      matches(outlet, release.payload) &&
      (!release.sample || outlet.is_sample === true);
    rows.push({
      outletId,
      code: outlet.code,
      name: outlet.name,
      channel: outlet.channel,
      subchannel: outlet.subchannel,
      classification: outlet.classification,
      setId: resolved?.id ?? null,
      label:
        release.kind === "msl"
          ? (resolved?.label ?? "No MSL assigned")
          : applicable
            ? release.label
            : "Not in this audience",
      lines:
        release.kind === "msl"
          ? (resolved?.payload.lines.length ?? 0)
          : applicable
            ? (release.payload.lines?.length ??
              release.payload.productIds?.length ??
              0)
            : 0,
    });
  }
  const hash = sha256Hex(canonicalJson({ release, rows }));
  return { releaseId: id, kind: release.kind, rows, hash };
}
/** @param {any} ctx */
export async function publishRelease(ctx) {
  await manage(ctx);
  await ctx.db`select pg_advisory_xact_lock(4490211)`;
  const result = await preview(ctx);
  if (ctx.body.previewHash !== result.hash)
    throw conflict(
      "Preview changed. Review it again before publishing.",
      "preview_changed",
    );
  const [r] =
    await ctx.db`select * from availability_releases where id=${result.releaseId} for update`;
  if (r.status === "published") return { id: r.id, duplicate: true };
  const later =
    await ctx.db`select 1 from availability_releases where kind=${r.kind} and policy_key=${r.policy_key} and status='published' and effective_from>=${r.effective_from}`;
  if (later.length) throw conflict("A later version is already scheduled");
  await ctx.db`update availability_releases set effective_to=${r.effective_from},updated_at=now() where kind=${r.kind} and policy_key=${r.policy_key} and status='published' and effective_from<${r.effective_from} and (effective_to is null or effective_to>${r.effective_from})`;
  await ctx.db`update availability_releases set status='published',published_at=now(),updated_at=now() where id=${r.id}`;
  await audit(ctx, "availability.published", r.id);
  await ctx.change("availability.policy", r.id, "field:reference");
  ctx.publish("analytics");
  ctx.publish("availability");
  return { id: r.id, duplicate: false };
}
/** @param {any} ctx @param {string} action @param {string} id */
export async function audit(ctx, action, id) {
  await writeAudit(ctx.db, {
    subject: ctx.actor.subject,
    action,
    entityType: "availability",
    entityId: id,
    details: null,
  });
}
/** @param {any} db @param {string} table @param {string} id @param {string} key */
export async function markSample(db, table, id, key) {
  await db`insert into sample_data_rows(batch,table_name,row_id,key) values ('sunpride-availability-v1',${table},${id},${key}) on conflict do nothing`;
}
