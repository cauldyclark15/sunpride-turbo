import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { canonicalJson } from "../../core/util.js";
import { rule, required, uuid } from "../org/model.js";
import { access } from "../org/readers.js";
import { definitionsAt, reference } from "./definitions.js";

/** F-013 one canonical dictionary, with an explicit compatibility bridge for old keys.
 * SEAM(CALLFLOW/SAP): consume this current taxonomy instead of interpreting legacy strings.
 * Historical signed call snapshots remain authoritative; this is deliberately a current lookup.
 * @param {any} ctx @param {string} outletId */
export async function currentOutletTaxonomy(ctx, outletId) {
  const outlet = await access(ctx, "outlets", outletId, "outlet.read");
  const { channels, subs, aliases } = await dictionary(ctx);
  const alias = aliases.find(
    (/** @type {any} */ a) => a.legacy_key === outlet.channel,
  );
  const channel = channels.find(
    (/** @type {any} */ v) => v.id === (outlet.channel_id ?? alias?.channel_id),
  );
  const sub = subs.find(
    (/** @type {any} */ v) =>
      v.id === (outlet.subchannel_id ?? alias?.subchannel_id),
  );
  return channel && sub && sub.data.channelId === channel.id
    ? {
        status: "resolved",
        channelId: channel.id,
        channelVersionId: channel.version_id,
        channel: channel.label,
        subchannelId: sub.id,
        subchannelVersionId: sub.version_id,
        subchannel: sub.label,
        legacyKey: outlet.channel,
      }
    : { status: "needs_review", legacyKey: outlet.channel };
}
/** @param {any} ctx */
async function dictionary(ctx) {
  const channels = (await definitionsAt(ctx, "channel")).filter(
    (/** @type {any} */ v) => v.status === "active",
  );
  const subs = (await definitionsAt(ctx, "subchannel")).filter(
    (/** @type {any} */ v) => v.status === "active",
  );
  const aliases = (
    await ctx.db`select * from master_channel_aliases order by legacy_key`
  ).filter(
    (/** @type {any} */ a) =>
      channels.some((/** @type {any} */ c) => c.id === a.channel_id) &&
      subs.some(
        (/** @type {any} */ s) =>
          s.id === a.subchannel_id && s.data.channelId === a.channel_id,
      ),
  );
  return { channels, subs, aliases };
}
/** @param {any} ctx @param {boolean} [lock] */
async function plan(ctx, lock = false) {
  await requireCapability(ctx, "masterdata.manage");
  await requireNationalScope(ctx, ["admin", "operations"]);
  const { channels, subs, aliases } = await dictionary(ctx);
  const outlets = lock
    ? await ctx.db`select id,code,name,channel,channel_id,subchannel_id from outlets where deleted_at is null and (channel_id is null or subchannel_id is null) order by id limit 2001 for update`
    : await ctx.db`select id,code,name,channel,channel_id,subchannel_id from outlets where deleted_at is null and (channel_id is null or subchannel_id is null) order by id limit 2001`;
  const customers = lock
    ? await ctx.db`select id,code,name,channel,channel_id from customers where deleted_at is null and channel_id is null order by id limit 2001 for update`
    : await ctx.db`select id,code,name,channel,channel_id from customers where deleted_at is null and channel_id is null order by id limit 2001`;
  if (outlets.length + customers.length > 2000)
    rule(
      "Legacy channel review supports 2,000 unmapped records per cutover. Narrow the source first.",
      "overflow",
    );
  const rows = [
    ...outlets.map((/** @type {any} */ r) => ({ ...r, kind: "outlet" })),
    ...customers.map((/** @type {any} */ r) => ({ ...r, kind: "customer" })),
  ].map((r) => {
    const alias = aliases.find(
      (/** @type {any} */ a) =>
        a.legacy_key === r.channel &&
        (r.channel_id == null || r.channel_id === a.channel_id) &&
        (r.subchannel_id == null || r.subchannel_id === a.subchannel_id),
    );
    return {
      ...r,
      channelId: alias?.channel_id ?? null,
      subchannelId: alias?.subchannel_id ?? null,
    };
  });
  const hash = new Bun.CryptoHasher("sha256")
    .update(
      canonicalJson({
        rows,
        versions: [...channels, ...subs]
          .map((/** @type {any} */ v) => v.version_id)
          .sort(),
      }),
    )
    .digest("hex");
  return { rows, hash, channels, subs };
}
/** F-013 preview never adopts unknown source strings or edits the original key. @param {any} ctx */
export async function taxonomyMigrationPreview(ctx) {
  await requireCapability(ctx, "masterdata.manage");
  try {
    await requireNationalScope(ctx, ["admin", "operations"]);
  } catch (e) {
    if (/** @type {any} */ (e).status === 403) return { allowed: false };
    throw e;
  }
  const { rows, hash, channels, subs } = await plan(ctx);
  const ready = rows.filter((r) => r.channelId);
  return {
    allowed: true,
    previewHash: hash,
    readyOutlets: ready.filter((r) => r.kind === "outlet").length,
    readyCustomers: ready.filter((r) => r.kind === "customer").length,
    unknown: rows
      .filter((r) => !r.channelId)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        code: r.code,
        name: r.name,
        currentChannelId: r.channel_id ?? null,
        legacyKey: r.channel ?? "(blank)",
      })),
    channels: channels.map((/** @type {any} */ v) => ({
      id: v.id,
      label: v.label,
    })),
    subchannels: subs.map((/** @type {any} */ v) => ({
      id: v.id,
      label: v.label,
      channelId: v.data.channelId,
    })),
  };
}
/** F-013 reviewed, additive cutover for existing client records as well as samples.
 * Uses the existing master command transaction/receipt/audit, not a second importer.
 * @param {any} ctx @param {any} p */
export async function migrateLegacyTaxonomy(ctx, p) {
  const { rows, hash } = await plan(ctx, true);
  if (p.previewHash !== hash)
    rule(
      "Legacy rows or taxonomy changed. Review a fresh preview before applying.",
    );
  const reason = required(p.reason, "Migration review reason", 500);
  let outlets = 0,
    customers = 0;
  for (const row of rows) {
    if (!row.channelId) continue;
    if (row.kind === "outlet") {
      const updated =
        await ctx.db`update outlets set channel_id=coalesce(channel_id,${row.channelId}),subchannel_id=coalesce(subchannel_id,${row.subchannelId}) where id=${row.id} and (channel_id is null or subchannel_id is null) returning id`;
      outlets += updated.length;
    } else {
      const updated =
        await ctx.db`update customers set channel_id=${row.channelId} where id=${row.id} and channel_id is null returning id`;
      customers += updated.length;
    }
  }
  const unknown = rows.filter((r) => !r.channelId).length;
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${ctx.actor.userId},'F-013.legacy-taxonomy.migrate','master_taxonomy','legacy-channel-cutover',${JSON.stringify({ outlets, customers, unknown, previewHash: hash, reason })})`;
  return { outlets, customers, unknown };
}
/** F-013 human resolution of an unknown legacy key, including accounting customers.
 * Fill missing identities only; never overwrite an already governed assignment.
 * @param {any} ctx @param {any} p */
export async function assignLegacyTaxonomy(ctx, p) {
  await requireCapability(ctx, "masterdata.manage");
  await requireNationalScope(ctx, ["admin", "operations"]);
  const id = uuid(p.id),
    reason = required(p.reason, "Review reason", 500);
  const channel = await reference(ctx, p.channelId, "channel", ctx.now);
  if (!["outlet", "customer"].includes(p.kind))
    rule("Choose a store or accounting customer.");
  const [row] =
    p.kind === "outlet"
      ? await ctx.db`select * from outlets where id=${id} and deleted_at is null for update`
      : await ctx.db`select * from customers where id=${id} and deleted_at is null for update`;
  if (!row) rule("This master is no longer available.");
  if (row.channel_id != null && row.channel_id !== channel.id)
    rule(
      "This record already has a governed channel. Use its ordinary editor to change it.",
    );
  let sub = null;
  if (p.kind === "outlet") {
    sub = await reference(ctx, p.subchannelId, "subchannel", ctx.now);
    if (sub.data.channelId !== channel.id)
      rule("Sub-channel does not belong to this channel.");
    if (row.subchannel_id != null && row.subchannel_id !== sub.id)
      rule(
        "This store already has a governed sub-channel. Use its ordinary editor to change it.",
      );
    await ctx.db`update outlets set channel_id=coalesce(channel_id,${channel.id}),subchannel_id=coalesce(subchannel_id,${sub.id}) where id=${id}`;
  } else
    await ctx.db`update customers set channel_id=coalesce(channel_id,${channel.id}) where id=${id}`;
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${ctx.actor.userId},'F-013.legacy-taxonomy.assign',${p.kind},${id},${JSON.stringify({ legacyKey: row.channel, channelId: channel.id, subchannelId: sub?.id ?? null, reason })})`;
  return { id, channelId: channel.id, subchannelId: sub?.id ?? null };
}
