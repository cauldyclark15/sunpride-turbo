import { tx } from "@sunpride/db/client";
import { payloadHash } from "../../../../../packages/integration-contracts/sap/v1/index.js";
import { recordChange } from "../../core/sync.js";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { scopeFilterForActor } from "../org/scope.js";

/** F-004: authorize master identities again on every snapshot and delta; no national customer/price leakage.
 * @param {any} ctx
 */
async function grants(ctx) {
  await requireCapability(ctx, "report.read");
  const db = ctx.db;
  const { unitIds } = await scopeFilterForActor(db, ctx.actor);
  if (unitIds === null) return null;
  /** @type {any[]} */ const outlets =
    await db`select distinct o.id,o.code,c.code as customer_code,coalesce(o.channel,c.channel) as channel from outlets o
    left join outlet_customer_links link on link.outlet_id=o.id and link.deleted_at is null and link.effective_from<=now() and (link.effective_to is null or link.effective_to>now())
    left join customers c on c.id=link.customer_id and c.deleted_at is null
    where o.deleted_at is null and exists(select 1 from planned_visits p join coverage_plans cp on cp.id=p.plan_id where cp.status in ('approved','active') and cp.approval_signature is not null and cp.deleted_at is null and p.status='planned' and p.outlet_id=o.id and p.assignee_profile_id=${ctx.actor.profileId} and p.deleted_at is null and p.service_date>=(now() at time zone 'Asia/Manila')::date and p.service_date<=(now() at time zone 'Asia/Manila')::date+2)`;
  // Resolve the same current persisted ownership invariant in bounded bulk reads,
  // not three history queries per store on every sync page.
  const outletIds = [...new Set(outlets.map((o) => o.id))];
  /** @type {any[]} */ const assignments = outletIds.length
    ? await db`select outlet_id,territory_id from outlet_assignments where outlet_id in ${db(outletIds)} and deleted_at is null and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)})`
    : [];
  const territoryIds = [...new Set(assignments.map((a) => a.territory_id))];
  /** @type {any[]} */ const owners = territoryIds.length
    ? await db`select territory_id,org_unit_id from territory_ownerships where territory_id in ${db(territoryIds)} and deleted_at is null and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)})`
    : [];
  /** @type {any[]} */ const custodians = outletIds.length
    ? await db`select id,custodian_org_unit_id from outlets where id in ${db(outletIds)} and deleted_at is null`
    : [];
  const allowed = outlets.filter((o) => {
    const a = assignments.filter((a) => a.outlet_id === o.id);
    const t = a.length
      ? owners.filter((t) => t.territory_id === a[0].territory_id)
      : [];
    if (a.length > 1 || (a.length && t.length !== 1))
      throw new ApiError(
        "invalid_scope",
        409,
        "SAP master ownership is ambiguous or missing",
      );
    const owner = a.length
      ? t[0].org_unit_id
      : custodians.find((c) => c.id === o.id)?.custodian_org_unit_id;
    return owner && unitIds.includes(owner);
  });
  const ids = allowed.map((o) => o.id);
  const productRows = ids.length
    ? await db`select distinct p.code from products p join call_sheet_account_lines l on l.product_id=p.id join call_sheet_accounts a on a.id=l.call_sheet_account_id where a.outlet_id in ${db(ids)} and a.deleted_at is null and l.deleted_at is null`
    : [];
  const locations = unitIds.length
    ? await db`select code from inventory_locations where org_unit_id in ${db(unitIds)} and active and deleted_at is null`
    : [];
  return {
    outlets: new Set(allowed.map((o) => o.code)),
    channels: new Set(allowed.map((o) => o.channel)),
    products: new Set(productRows.map((/** @type {any} */ p) => p.code)),
    customers: new Set(allowed.map((o) => o.customer_code)),
    locations: new Set(locations.map((/** @type {any} */ l) => l.code)),
  };
}
/** Authorization withdrawal is a permanent cursor fence, not an empty successful delta.
 * @param {any} ctx
 */
async function grantManifest(ctx) {
  const g = await grants(ctx);
  const stamp = payloadHash(
    g === null
      ? null
      : {
          outlets: [...g.outlets].sort(),
          channels: [...g.channels].sort(),
          products: [...g.products].sort(),
          customers: [...g.customers].sort(),
          locations: [...g.locations].sort(),
        },
  );
  const changed = await tx(ctx.db, async (db) => {
    await db`select pg_advisory_xact_lock(hashtextextended(${`sap-grants:${ctx.device.id}`},0))`;
    const [old] =
      await db`select stamp from sap_projection_grants where id=${ctx.device.id} for update`;
    if (old?.stamp === stamp) return false;
    await db`insert into sap_projection_grants(id,profile_id,stamp) values(${ctx.device.id},${ctx.actor.profileId},${stamp}) on conflict(id) do update set profile_id=excluded.profile_id,stamp=excluded.stamp,updated_at=now()`;
    if (old)
      await recordChange(db, {
        entity: "sap.authorization",
        entityId: ctx.actor.profileId,
        scopeKey: `profile:${ctx.actor.profileId}`,
      });
    return Boolean(old);
  });
  return { stamp, changed };
}
/** @param {any} ctx @param {string[]|null} [ids] */
export async function masterRows(ctx, ids = null) {
  const db = ctx.db,
    permitted = await grants(ctx);
  const rows =
    await db`select * from (select distinct on(master_id) * from sap_replicas where change_seq<=${ctx.highWater ?? Number.MAX_SAFE_INTEGER} and effective_from<=${new Date(ctx.now)} and (${ids === null} or master_id in ${db(ids?.length ? ids : ["00000000-0000-0000-0000-000000000000"])}) order by master_id,sap_version desc) r order by master_id limit 10001`;
  if (rows.length > 10000)
    throw new ApiError(
      "master_overflow",
      409,
      "Master snapshot exceeds the supported bound; narrow the selling scope",
    );
  return rows
    .filter((/** @type {any} */ r) => {
      if (
        r.deleted_at ||
        (r.effective_to && new Date(r.effective_to).getTime() <= ctx.now)
      )
        return false;
      if (!permitted) return true;
      const d = r.payload.data;
      if (r.kind === "material") return permitted.products.has(d.code);
      if (r.kind === "condition")
        return (
          permitted.products.has(d.productCode) &&
          (!d.customerCode || permitted.customers.has(d.customerCode)) &&
          (!d.channelKey || permitted.channels.has(d.channelKey))
        );
      if (["customer", "ar"].includes(r.kind))
        return permitted.customers.has(d.customerCode ?? d.code);
      if (r.kind === "outlet") return permitted.outlets.has(d.code);
      if (r.kind === "location") return permitted.locations.has(d.locationCode);
      if (r.kind === "stock")
        return (
          permitted.products.has(d.productCode) &&
          permitted.locations.has(d.locationCode)
        );
      return false;
    })
    .map((/** @type {any} */ r) => ({
      id: r.master_id,
      revision: Number(r.change_seq),
      ...r.payload,
      receivedAt: new Date(r.received_at).getTime(),
    }));
}
/** @param {any} ctx */
export function installMasterProjection(ctx) {
  ctx.registerProjection("sap.masters", {
    params: () => ({}),
    entities: ["sap.master", "sap.authorization"],
    scopeKeys: async (/** @type {any} */ p) => {
      await requireCapability(p, "report.read");
      const g = await grantManifest(p);
      if (g.changed)
        throw new ApiError(
          "rebootstrap_required",
          409,
          "Selling authorization changed; refresh the authorized master snapshot",
        );
      return ["sap:masters", `profile:${p.actor.profileId}`];
    },
    snapshot: async (/** @type {any} */ p) => {
      const g = await grantManifest(p);
      if (p.state?.stamp && p.state.stamp !== g.stamp)
        throw new ApiError(
          "rebootstrap_required",
          409,
          "Selling authorization changed during snapshot",
        );
      const rows = await masterRows(p),
        offset = p.state?.offset ?? 0;
      return {
        data: { masters: rows.slice(offset, offset + p.limit) },
        next:
          rows.length > offset + p.limit
            ? { offset: offset + p.limit, stamp: g.stamp }
            : null,
      };
    },
    load: async (
      /** @type {any} */ p,
      /** @type {string} */ entity,
      /** @type {string[]} */ ids,
    ) => {
      if (entity === "sap.authorization")
        throw new ApiError(
          "rebootstrap_required",
          409,
          "Selling authorization changed; refresh masters",
        );
      return new Map(
        (await masterRows(p, ids)).map((/** @type {any} */ r) => [r.id, r]),
      );
    },
  });
}
