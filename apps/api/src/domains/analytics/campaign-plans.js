import { eligibility, schemeUnits } from "../tpm/engine.js";
import { eligibilityFacts } from "../tpm/campaigns.js";
import { ApiError } from "../../core/errors.js";

/** F-607: governed plans join current distributor/store ownership, not sample reporting replicas.
 * Campaign-wide volume is explicitly NOT repeated as a per-SKU demand forecast.
 * @param {any} ctx @param {any} p @param {any} s @param {any[]} rows */
export async function campaignDemandPlans(ctx, p, s, rows) {
  if (s.ownProfileId || !rows.length) return new Map();
  const schemes =
    await ctx.db`select p.id,p.rule,p.eligibility,p.source,v.id as version_id,v.campaign_id,v.version,v.name,v.mechanic,v.scope,v.expected_volume_base,v.effective_from,v.effective_to,v.source as campaign_source
    from promotions p join campaign_versions v on v.id=p.campaign_version_id
    where p.organization_id='sunpride' and p.status='active' and p.deleted_at is null and v.status in ('active','closed')
    and p.effective_from<(${p.to}::date+1)::timestamp at time zone 'Asia/Manila'
    and (p.effective_to is null or p.effective_to>${p.from}::date::timestamp at time zone 'Asia/Manila')
    and v.effective_from<(${p.to}::date+1)::timestamp at time zone 'Asia/Manila'
    and v.effective_to>${p.from}::date::timestamp at time zone 'Asia/Manila' order by v.id,p.id limit 501`;
  if (schemes.length > 500)
    throw new ApiError(
      "capacity",
      422,
      "Narrow the planning period; more than 500 governed schemes match",
    );
  const stores =
    await ctx.db`select d.id as distributor_id,g.outlet_id,o.channel from distributors d join distributor_outlets g on g.distributor_id=d.id join analytics_store_scope o on o.id=g.outlet_id
    where d.status='accredited' and d.org_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])} and o.owner_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])}
    and d.effective_from<=now() and (d.effective_to is null or d.effective_to>now())
    and g.effective_from<=now() and (g.effective_to is null or g.effective_to>now())
    and (${p.channel}::text is null or o.channel=${p.channel}) order by d.id,g.outlet_id limit 501`;
  if (stores.length > 500)
    throw new ApiError(
      "capacity",
      422,
      "Narrow the planning scope; more than 500 current distributor stores match",
    );
  const facts = new Map();
  /** @type {Map<string,any[]>} */ const result = new Map();
  for (const row of rows) {
    const plans = new Map();
    for (const store of stores.filter(
      (/** @type {any} */ item) => item.distributor_id === row.distributorKey,
    )) {
      if (!facts.has(store.outlet_id))
        facts.set(
          store.outlet_id,
          await eligibilityFacts(ctx, {
            outletId: store.outlet_id,
            channelKey: store.channel,
            at: ctx.now,
          }),
        );
      const fact = facts.get(store.outlet_id);
      for (const scheme of schemes) {
        const units = schemeUnits(scheme.rule);
        if (units.length && !units.some((u) => u.productId === row.productId))
          continue;
        if (
          !eligibility(scheme.eligibility ?? {}, fact).eligible ||
          !eligibility(scheme.scope ?? {}, fact).eligible
        )
          continue;
        plans.set(scheme.version_id, {
          campaign: scheme.name,
          sourceId: scheme.version_id,
          schemeId: scheme.id,
          version: scheme.version,
          mechanic: scheme.mechanic,
          plannedBase: null,
          campaignExpectedBase: Number(scheme.expected_volume_base),
          source: "campaign_versions",
          sample:
            scheme.source === "sample" || scheme.campaign_source === "sample",
          effectiveFrom: scheme.effective_from,
          effectiveTo: scheme.effective_to,
          notice: "Campaign-wide target, not allocated SKU demand",
        });
      }
    }
    result.set(row.key, [...plans.values()]);
  }
  return result;
}
