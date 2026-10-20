import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { scopeFilterForActor } from "../org/scope.js";
import { access } from "../org/readers.js";
import { code, required, uuid, integer, rule } from "../org/model.js";
import { polygon, containedRing } from "./geometry.js";

export const KINDS = Object.freeze([
  "geography",
  "beat",
  "channel",
  "subchannel",
  "class_policy",
  "msl",
  "chain",
  "banner",
  "branch",
]);
const GLOBAL = new Set(["channel", "subchannel", "class_policy", "msl"]);
/** @param {any} ctx @param {any} row @param {boolean} [write] */
export async function gate(ctx, row, write = false) {
  await requireCapability(
    ctx,
    write ? "masterdata.manage" : "outlet.read",
    row.org_unit_id,
  );
  if (!row.org_unit_id && write)
    await requireNationalScope(ctx, ["admin", "operations"]);
  if (!row.org_unit_id && !GLOBAL.has(row.kind))
    rule("This master needs an organizational owner.");
}
/** Scope is current even on historical reads. @param {any} ctx @param {string} kind @param {number} [at] */
export async function definitionsAt(ctx, kind, at = ctx.now) {
  if (!KINDS.includes(kind)) rule("Choose a master section.");
  integer(at, 0, 8640000000000000);
  const actor = await requireCapability(ctx, "outlet.read");
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  const rows =
    await ctx.db`select d.*,v.id version_id,v.version,v.label,v.status,v.data,v.effective_from,v.effective_to,v.reason,
    exists(select 1 from sample_data_rows s where s.table_name='master_definitions' and s.row_id=d.id::text) sample
    from master_definitions d join master_versions v on v.master_id=d.id
    where d.kind=${kind} and v.effective_from<=${new Date(at)} and (v.effective_to is null or v.effective_to>${new Date(at)})
    and (${unitIds === null} or d.org_unit_id is null or d.org_unit_id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")})) order by d.code limit 1001`;
  if (rows.length > 1000)
    rule(
      "This master exceeds 1,000 definitions. Narrow the organizational scope.",
      "overflow",
    );
  return rows;
}
/** @param {any} ctx @param {any} id @param {string} kind @param {number} at */
export async function reference(ctx, id, kind, at) {
  uuid(id);
  const [row] =
    await ctx.db`select d.*,v.id version_id,v.version,v.label,v.status,v.data,v.effective_from,v.effective_to from master_definitions d join master_versions v on v.master_id=d.id where d.id=${id} and d.kind=${kind} and v.effective_from<=${new Date(at)} and (v.effective_to is null or v.effective_to>${new Date(at)})`;
  if (!row || row.status !== "active")
    rule(
      `Choose an active ${kind.replaceAll("_", " ")} at the effective date.`,
    );
  await gate(ctx, row);
  return row;
}
/** @param {any} value @param {readonly string[]} values @param {string} label */
function one(value, values, label) {
  if (!values.includes(value)) rule(`Choose ${label}.`);
  return value;
}
/** @param {any} value @param {string[]} fields */
function fields(value, fields) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !fields.includes(k))
  )
    rule("This master contains unsupported fields.");
}
/** @param {any} p */
function point(p) {
  fields(p, ["label", "latitude", "longitude"]);
  if (
    !Number.isFinite(p.latitude) ||
    Math.abs(p.latitude) > 90 ||
    !Number.isFinite(p.longitude) ||
    Math.abs(p.longitude) > 180
  )
    rule("Choose a valid start and end point.");
  return {
    label: required(p.label, "Point name", 100),
    latitude: p.latitude,
    longitude: p.longitude,
  };
}
/** F-009/F-010/F-013/F-014/F-017/F-305 typed data boundary shared by web and seed.
 * No arbitrary master JSON reaches storage. @param {any} ctx @param {string} kind @param {any} p @param {number} at @param {string} id */
export async function validateDefinition(ctx, kind, p, at, id) {
  if (kind === "channel") {
    fields(p, []);
    return {};
  }
  if (kind === "subchannel") {
    fields(p, ["channelId"]);
    const parent = await reference(ctx, p.channelId, "channel", at);
    return { channelId: parent.id };
  }
  if (kind === "geography") {
    fields(p, ["type", "parentId", "polygon", "territoryId"]);
    const levels = ["region", "area", "territory", "zone"];
    const type = one(p.type, levels, "a geographic type"),
      level = levels.indexOf(type);
    const geometry = polygon(p.polygon);
    let parentId = null;
    if (level > 0) {
      const parent = await reference(ctx, p.parentId, "geography", at);
      if (parent.id === id || parent.data.type !== levels[level - 1])
        rule("Choose the immediately preceding geographic tier.");
      if (
        !containedRing(
          geometry.coordinates[0],
          parent.data.polygon.coordinates[0],
        )
      )
        rule("Boundary must be entirely inside its parent.");
      parentId = parent.id;
    } else if (p.parentId) rule("A region has no geographic parent.");
    // Revisions may not strand current or already-scheduled child geometry.
    const children =
      await ctx.db`select v.data from master_versions v join master_definitions d on d.id=v.master_id where d.kind='geography' and v.data->>'parentId'=${id} and v.status='active' and (v.effective_to is null or v.effective_to>${new Date(at)})`;
    for (const child of children)
      if (
        child.data.type !== levels[level + 1] ||
        !containedRing(
          child.data.polygon.coordinates[0],
          geometry.coordinates[0],
        )
      )
        rule("This change would exclude a child boundary.");
    const territoryId = p.territoryId ? uuid(p.territoryId) : null;
    if (territoryId) {
      if (type !== "territory")
        rule("Only a territory can map to the route territory master.");
      await access(ctx, "territories", territoryId, "territory.read");
    }
    return { type, parentId, polygon: geometry, territoryId };
  }
  if (kind === "beat") {
    fields(p, [
      "routeId",
      "geographyId",
      "weekdays",
      "cycleWeeks",
      "start",
      "end",
      "expectedOutlets",
      "distanceMeters",
      "repId",
      "vanId",
    ]);
    await access(ctx, "routes", uuid(p.routeId), "route.read");
    const geography = await reference(ctx, p.geographyId, "geography", at);
    if (!["territory", "zone"].includes(geography.data.type))
      rule("A beat needs a territory or zone.");
    if (
      !Array.isArray(p.weekdays) ||
      !p.weekdays.length ||
      p.weekdays.length > 7 ||
      new Set(p.weekdays).size !== p.weekdays.length
    )
      rule("Choose distinct days of the week.");
    p.weekdays.forEach((/** @type {any} */ d) => integer(d, 0, 6));
    if (Boolean(p.repId) === Boolean(p.vanId))
      rule("Assign either a rep or a van.");
    if (p.repId) {
      const rep = await access(ctx, "people", uuid(p.repId), "people.read");
      if (rep.role !== "sales" || rep.status !== "active")
        rule("Assign an active sales rep.");
    }
    if (p.vanId) {
      const [van] =
        await ctx.db`select * from vehicles where id=${uuid(p.vanId)}`;
      if (!van || van.status !== "active") rule("Choose an active van.");
      await requireCapability(ctx, "van.read", van.org_unit_id);
    }
    return {
      routeId: p.routeId,
      geographyId: geography.id,
      weekdays: [...p.weekdays].sort(),
      cycleWeeks: integer(p.cycleWeeks, 1, 12),
      start: point(p.start),
      end: point(p.end),
      expectedOutlets: integer(p.expectedOutlets, 1, 1000),
      distanceMeters: integer(p.distanceMeters, 0, 1000000),
      repId: p.repId ?? null,
      vanId: p.vanId ?? null,
    };
  }
  if (kind === "class_policy") {
    fields(p, ["bands"]);
    if (!Array.isArray(p.bands) || p.bands.length !== 4)
      rule("Set four revenue-potential bands.");
    let prior = Number.MAX_SAFE_INTEGER;
    const bands = p.bands.map(
      (/** @type {any} */ b, /** @type {number} */ i) => {
        fields(b, ["class", "minPotentialCentavos"]);
        if (b.class !== ["A", "B", "C", "D"][i])
          rule("Bands must be A, B, C, D in order.");
        const min = integer(b.minPotentialCentavos, 0);
        if (min >= prior || (i === 3 && min !== 0))
          rule("Thresholds must descend strictly, ending at zero for D.");
        prior = min;
        return { class: b.class, minPotentialCentavos: min };
      },
    );
    // One policy identity: ambiguity cannot be solved by last-row-wins.
    const others = (await definitionsAt(ctx, "class_policy", at)).filter(
      (/** @type {any} */ r) => r.id !== id && r.status === "active",
    );
    if (others.length)
      rule(
        "Revise the existing potential policy rather than create a competing one.",
      );
    return { bands };
  }
  if (kind === "msl") {
    fields(p, ["channelId", "subchannelId", "outletClass", "productIds"]);
    const channel = await reference(ctx, p.channelId, "channel", at);
    const sub = p.subchannelId
      ? await reference(ctx, p.subchannelId, "subchannel", at)
      : null;
    if (sub && sub.data.channelId !== channel.id)
      rule("Sub-channel does not belong to this channel.");
    const outletClass = one(
      p.outletClass,
      ["A", "B", "C", "D"],
      "an outlet class",
    );
    if (
      !Array.isArray(p.productIds) ||
      !p.productIds.length ||
      p.productIds.length > 200 ||
      new Set(p.productIds).size !== p.productIds.length
    )
      rule("Choose 1 to 200 distinct MSL products.");
    for (const productId of p.productIds) {
      uuid(productId);
      const [product] =
        await ctx.db`select id from products where id=${productId} and active and deleted_at is null`;
      if (!product) rule("An MSL product is inactive or missing.");
    }
    const overlaps =
      await ctx.db`select 1 from master_definitions d join master_versions v on v.master_id=d.id where d.kind='msl' and d.id<>${id} and v.status='active' and v.data->>'channelId'=${channel.id} and coalesce(v.data->>'subchannelId','')=${sub?.id ?? ""} and v.data->>'outletClass'=${outletClass} and (v.effective_to is null or v.effective_to>${new Date(at)}) limit 1`;
    if (overlaps.length)
      rule("An MSL profile already covers these exact criteria.");
    return {
      channelId: channel.id,
      subchannelId: sub?.id ?? null,
      outletClass,
      productIds: p.productIds,
    };
  }
  if (kind === "chain") {
    fields(p, []);
    return {};
  }
  if (kind === "banner") {
    fields(p, ["chainId"]);
    const chain = await reference(ctx, p.chainId, "chain", at);
    return { chainId: chain.id };
  }
  if (kind === "branch") {
    fields(p, ["bannerId", "outletId", "sapCustomerId"]);
    const banner = await reference(ctx, p.bannerId, "banner", at);
    await access(ctx, "outlets", uuid(p.outletId), "outlet.read");
    const [customer] =
      await ctx.db`select id from customers where id=${uuid(p.sapCustomerId)} and active and deleted_at is null`;
    if (!customer) rule("Choose an active SAP accounting customer.");
    const [link] =
      await ctx.db`select 1 from outlet_customer_links where outlet_id=${p.outletId} and customer_id=${p.sapCustomerId} and deleted_at is null and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
    if (!link)
      rule(
        "The branch must use the outlet's effective accounting-customer mapping.",
      );
    return {
      bannerId: banner.id,
      outletId: p.outletId,
      sapCustomerId: p.sapCustomerId,
    };
  }
  rule("Unsupported master section.");
}
/** F-014 prospective potential, never actual revenue. @param {any} inputs @param {any} policy */
export function potentialClass(inputs, policy) {
  fields(inputs, [
    "transactionsPerDay",
    "averageBasketCentavos",
    "tradingDaysPerMonth",
    "captureRatePct",
  ]);
  const transactions = integer(inputs.transactionsPerDay, 0, 100000),
    basket = integer(inputs.averageBasketCentavos, 0, 100000000),
    days = integer(inputs.tradingDaysPerMonth, 1, 31),
    capture = integer(inputs.captureRatePct, 0, 100);
  const scaled = transactions * basket * days * capture;
  if (!Number.isSafeInteger(scaled))
    rule("Revenue-potential inputs exceed the supported amount.");
  const potentialCentavos = Math.round(scaled / 100);
  const band = policy.bands.find(
    (/** @type {any} */ b) => potentialCentavos >= b.minPotentialCentavos,
  );
  if (!band) rule("The potential policy has no matching class.");
  return { potentialCentavos, derivedClass: band.class };
}
/** @param {any} row */
export const masterDto = (row) => ({
  id: row.id,
  kind: row.kind,
  code: row.code,
  orgUnitId: row.org_unit_id,
  versionId: row.version_id,
  version: row.version,
  label: row.label,
  status: row.status,
  data: row.data,
  effectiveFrom: new Date(row.effective_from).getTime(),
  effectiveTo: row.effective_to ? new Date(row.effective_to).getTime() : null,
  sample: row.sample ?? false,
});
/** @param {any} ctx @param {any} p */
export async function saveDefinition(ctx, p) {
  if (!KINDS.includes(p.kind)) rule("Choose a master section.");
  const actor = await requireCapability(ctx, "masterdata.manage");
  const at =
    p.effectiveFrom == null
      ? ctx.now
      : integer(p.effectiveFrom, ctx.now, ctx.now + 366 * 86400000);
  const key = code(p.code),
    label = required(p.label, "Name", 160),
    reason = required(p.reason, "Reason", 500);
  one(p.status, ["active", "inactive"], "a status");
  integer(p.baseVersion, 0);
  await ctx.db`select pg_advisory_xact_lock(4310420)`;
  const [existing] =
    await ctx.db`select * from master_definitions where kind=${p.kind} and code=${key}`;
  const scope = GLOBAL.has(p.kind)
    ? null
    : uuid(p.orgUnitId, "Organizational owner");
  const definition = existing ?? {
    id: crypto.randomUUID(),
    kind: p.kind,
    code: key,
    org_unit_id: scope,
  };
  await gate(ctx, definition, true);
  if (existing && existing.org_unit_id !== scope)
    rule(
      "Scope is fixed for this identity; use an explicitly owned replacement.",
    );
  const versions = existing
    ? await ctx.db`select * from master_versions where master_id=${existing.id} order by version desc limit 1`
    : [];
  const previous = versions[0];
  if ((previous?.version ?? 0) !== p.baseVersion)
    throw new ApiError(
      "stale_version",
      409,
      "This master changed. Reload before saving.",
    );
  if (previous && new Date(previous.effective_from).getTime() >= at)
    rule("A version already starts at or after this date.");
  const data = await validateDefinition(ctx, p.kind, p.data, at, definition.id);
  // Do not retire or reparent a definition that is still referenced, even by a future version.
  if (
    p.status === "inactive" ||
    (previous &&
      (previous.data.channelId !== data.channelId ||
        previous.data.parentId !== data.parentId ||
        previous.data.chainId !== data.chainId ||
        previous.data.bannerId !== data.bannerId))
  ) {
    const [used] =
      await ctx.db`select 1 from master_versions where master_id<>${definition.id} and status='active' and (effective_to is null or effective_to>${new Date(at)}) and (data->>'parentId'=${definition.id} or data->>'channelId'=${definition.id} or data->>'subchannelId'=${definition.id} or data->>'geographyId'=${definition.id} or data->>'chainId'=${definition.id} or data->>'bannerId'=${definition.id}) limit 1`;
    const [outlet] =
      await ctx.db`select 1 from outlets where deleted_at is null and status<>'inactive' and (channel_id=${definition.id} or subchannel_id=${definition.id} or geography_id=${definition.id}) limit 1`;
    if (used || outlet)
      rule(
        "Move active dependent masters or stores before retiring or reparenting this definition.",
      );
  }
  if (!existing)
    await ctx.db`insert into master_definitions(id,kind,code,org_unit_id) values(${definition.id},${p.kind},${key},${scope})`;
  if (previous)
    await ctx.db`update master_versions set effective_to=${new Date(at)} where id=${previous.id}`;
  const [version] =
    await ctx.db`insert into master_versions(master_id,version,label,status,data,effective_from,actor_profile_id,reason) values(${definition.id},${p.baseVersion + 1},${label},${p.status},${data},${new Date(at)},${actor.profileId},${reason}) returning *`;
  await ctx.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},${`masters.${p.kind}.version`},'master',${definition.id},${JSON.stringify({ version: version.version, reason })})`;
  return masterDto({
    ...definition,
    ...version,
    id: definition.id,
    version_id: version.id,
  });
}
