import { requireCapability } from "../../core/capabilities.js";
import { access } from "../org/readers.js";
import { required, uuid, rule } from "../org/model.js";
import { definitionsAt, reference, potentialClass } from "./definitions.js";
import { distance } from "./geometry.js";

/** F-014 persist the scoring explanation, rule version and independent override reason.
 * @param {any} ctx @param {any} p */
export async function classify(ctx, p) {
  const actor = await requireCapability(ctx, "outlet.verify");
  const outlet = await access(
    ctx,
    "outlets",
    uuid(p.outletId),
    "outlet.verify",
  );
  const policies = (await definitionsAt(ctx, "class_policy")).filter(
    (/** @type {any} */ r) => r.status === "active",
  );
  if (policies.length !== 1)
    rule("Set up one effective revenue-potential policy first.");
  const policy = policies[0];
  if (p.policyVersionId !== policy.version_id)
    rule("The potential policy changed. Preview again.");
  const result = potentialClass(p.inputs, policy.data);
  const assignedClass = p.overrideClass ?? result.derivedClass;
  if (!["A", "B", "C", "D"].includes(assignedClass))
    rule("Choose A, B, C or D.");
  const reason = required(p.reason, "Decision reason", 500);
  if (assignedClass !== result.derivedClass && actor.role === "sales")
    rule("A reviewer must authorize a potential-class override.");
  const [decision] =
    await ctx.db`insert into outlet_class_decisions(outlet_id,policy_version_id,inputs,potential_centavos,derived_class,assigned_class,actor_profile_id,reason,effective_from) values(${outlet.id},${policy.version_id},${p.inputs},${result.potentialCentavos},${result.derivedClass},${assignedClass},${actor.profileId},${reason},${new Date(ctx.now)}) returning id`;
  await ctx.db`update outlets set classification=${assignedClass},sales_potential=${result.potentialCentavos / 100} where id=${outlet.id}`;
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},'F-014.outlet.classify','outlet',${outlet.id},${JSON.stringify({ decisionId: decision.id, priorClass: outlet.classification, assignedClass, reason })})`;
  return { id: decision.id, ...result, assignedClass };
}
/** F-013 controlled outlet taxonomy; old source strings are retained in audit, not
 * misrepresented as a governed channel. @param {any} ctx @param {any} p */
export async function setTaxonomy(ctx, p) {
  const outlet = await access(
    ctx,
    "outlets",
    uuid(p.outletId),
    "outlet.manage",
  );
  const channel = await reference(ctx, p.channelId, "channel", ctx.now),
    sub = await reference(ctx, p.subchannelId, "subchannel", ctx.now);
  if (sub.data.channelId !== channel.id)
    rule("Sub-channel does not belong to this channel.");
  await ctx.db`update outlets set channel_id=${channel.id},subchannel_id=${sub.id} where id=${outlet.id}`;
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${ctx.actor.userId},'F-013.outlet.taxonomy','outlet',${outlet.id},${JSON.stringify({ before: { channelId: outlet.channel_id, subchannelId: outlet.subchannel_id }, after: { channelId: channel.id, subchannelId: sub.id }, reason: required(p.reason, "Reason", 500) })})`;
  return { outletId: outlet.id, channelId: channel.id, subchannelId: sub.id };
}
/** @param {string} value */
const normalized = (value) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
/** @param {string} a @param {string} b */
export function nameSimilarity(a, b) {
  const x = new Set(normalized(a).split(" ").filter(Boolean)),
    y = new Set(normalized(b).split(" ").filter(Boolean));
  if (!x.size || !y.size) return 0;
  return [...x].filter((v) => y.has(v)).length / new Set([...x, ...y]).size;
}
/** @param {any} ctx @param {string} outletId */
export async function duplicateCandidates(ctx, outletId) {
  await access(ctx, "outlets", uuid(outletId), "outlet.verify");
  const rows =
    await ctx.db`select o.id,o.name,o.code,o.address,p.latitude,p.longitude,
    coalesce((select jsonb_agg(regexp_replace(c.phone,'[^0-9]','','g')) from outlet_contacts c where c.outlet_id=o.id and c.deleted_at is null and length(regexp_replace(c.phone,'[^0-9]','','g'))>=7),'[]'::jsonb) phones
    from outlets o left join lateral(select latitude,longitude from outlet_pins where outlet_id=o.id and status='verified' and deleted_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) order by effective_from desc limit 1) p on true
    where o.deleted_at is null and o.status<>'inactive' and not exists(select 1 from outlet_survivors s where s.source_outlet_id=o.id) order by o.id limit 2001`;
  if (rows.length > 2000)
    rule(
      "Duplicate review supports 2,000 active stores. Narrow the universe before review.",
      "overflow",
    );
  const source = rows.find((/** @type {any} */ r) => r.id === outletId);
  if (!source) rule("Only an active survivor can be reviewed.");
  const candidates = [];
  for (const row of rows) {
    if (row.id === outletId) continue;
    const metres =
      source.latitude == null || row.latitude == null
        ? null
        : distance(
            source.latitude,
            source.longitude,
            row.latitude,
            row.longitude,
          );
    const nameScore = nameSimilarity(source.name, row.name),
      sameContact = source.phones.some((/** @type {string} */ p) =>
        row.phones.includes(p),
      );
    if (!sameContact && !(metres !== null && metres <= 150 && nameScore >= 0.4))
      continue;
    try {
      await access(ctx, "outlets", row.id, "outlet.verify");
    } catch (e) {
      if ([403, 404].includes(/** @type {any} */ (e).status)) continue;
      throw e;
    }
    candidates.push({
      id: row.id,
      name: row.name,
      code: row.code,
      address: row.address,
      distanceMeters: metres === null ? null : Math.round(metres),
      nameScore,
      sameContact,
    });
  }
  return {
    source: { id: source.id, name: source.name, code: source.code },
    candidates: candidates.sort(
      (a, b) =>
        Number(b.sameContact) - Number(a.sameContact) ||
        b.nameScore - a.nameScore,
    ),
  };
}
/** F-012 immutable survivor aliases instead of destructive FK rewrites.
 * @param {any} db @param {string} id */
export async function canonicalOutletId(db, id) {
  uuid(id);
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    if (seen.has(id)) rule("Outlet survivor cycle.");
    seen.add(id);
    const [alias] =
      await db`select survivor_outlet_id from outlet_survivors where source_outlet_id=${id}`;
    if (!alias) return id;
    id = alias.survivor_outlet_id;
  }
  rule("Outlet survivor chain exceeds its bound.", "overflow");
}
/** @param {any} ctx @param {any} p */
export async function mergeOutlets(ctx, p) {
  await requireCapability(ctx, "outlet.verify");
  await ctx.db`select pg_advisory_xact_lock(4310420)`;
  const source = await access(
    ctx,
    "outlets",
    uuid(p.sourceOutletId),
    "outlet.verify",
  );
  const target = await access(
    ctx,
    "outlets",
    uuid(p.survivorOutletId),
    "outlet.verify",
  );
  if (
    source.id === target.id ||
    source.status === "inactive" ||
    target.status !== "active"
  )
    rule("Choose different active source and survivor stores.");
  if (
    (await canonicalOutletId(ctx.db, target.id)) !== target.id ||
    (await canonicalOutletId(ctx.db, source.id)) !== source.id
  )
    rule("One selected store already has a survivor. Reload the review.");
  const reason = required(p.reason, "Merge reason", 500);
  const [alias] =
    await ctx.db`insert into outlet_survivors(source_outlet_id,survivor_outlet_id,actor_profile_id,reason,effective_from) values(${source.id},${target.id},${ctx.actor.profileId},${reason},${new Date(ctx.now)}) returning id`;
  await ctx.db`update outlets set status='inactive' where id=${source.id}`;
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${ctx.actor.userId},'F-012.outlet.merge','outlet',${source.id},${JSON.stringify({ survivorOutletId: target.id, reason, historyPreserved: true })})`;
  return {
    id: alias.id,
    sourceOutletId: source.id,
    survivorOutletId: target.id,
    historyPreserved: true,
  };
}
