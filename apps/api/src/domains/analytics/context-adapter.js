// SEAM(MASTERS): provided outlet class/potential; no parallel classification master.
// SEAM(PROGRAMME): provided execution scores/assets/incidents; no duplicate writers.
// SEAM(INTEGRITY): detector findings/review links are read replicas, not tower-owned detectors.
import { inputObject, uuidInput } from "./inputs.js";
import { ApiError } from "../../core/errors.js";
import { tx } from "@sunpride/db/client";
import { requireCapability } from "../../core/capabilities.js";
import { scopeFor, pct, kpi } from "./measures.js";
import { availabilityModel } from "./availability-adapter.js";
import { canonicalOutletContext } from "./canonical-context.js";
import { readQueue } from "../integrity/detectors.js";
import { roleHas } from "../../core/capabilities.js";

/** F-604 SEAM(PROGRAMME/MASTERS): read replicas until upstream canonical readers land.
 * Caller already gates outlet; each replica is independently scoped and effective-dated.
 * @param {any} db @param {any} p @param {any} s @param {any} store @param {any} [ctx] */
export async function outletContext(db, p, s, store, ctx) {
  const [rows, competitors, av] = await Promise.all([
    db`select * from analytics_outlet_context where outlet_id=${store.id} and org_unit_id in ${db(s.ids.length ? s.ids : [null])} and effective_from<=${p.to + "T23:59:59.999+08:00"} and (effective_to is null or effective_to>${p.to + "T23:59:59.999+08:00"}) order by effective_from desc,id`,
    db`select c.id,c.kind,c.brand,c.product_category,c.observed_price_minor,c.service_date,c.note from competitor_observations c join merchandising_audits a on a.id=c.audit_id where c.outlet_id=${store.id} and c.deleted_at is null and a.deleted_at is null and c.org_unit_id in ${db(s.ids.length ? s.ids : [null])} and (${s.ownProfileId}::uuid is null or a.assignee_profile_id=${s.ownProfileId}) and c.service_date between ${p.from} and ${p.to} order by c.service_date desc,c.id`,
    availabilityModel(db, p, s),
  ]);
  const canonical = await canonicalOutletContext(db, p, s, store, ctx);
  const items = rows.map((/** @type {any} */ r) => ({
    kind: r.kind,
    ...r.payload,
    source: {
      system: r.source_system,
      key: r.source_key,
      revision: r.source_revision,
      sample: r.source_type === "sample",
    },
  }));
  return {
    coverage:
      /** @type {{planned:number,visited:number,missed:number}|null} */ (null),
    classification: canonical.classification ??
      items.find((/** @type {any} */ r) => r.kind === "class") ?? {
        label: "Not classified",
        potential: store.sales_potential ?? null,
      },
    executionScore: canonical.executionScore ??
      (canonical.hasExecution
        ? { value: null, reason: "Complete the governed retail scorecard" }
        : null) ??
      items.find((/** @type {any} */ r) => r.kind === "execution_score") ?? {
        value: null,
        reason: "Execution score source not connected",
      },
    assets: canonical.assets.length
      ? canonical.assets
      : items.filter((/** @type {any} */ r) => r.kind === "asset"),
    issues: canonical.hasExecution
      ? canonical.issues
      : items.filter((/** @type {any} */ r) => r.kind === "issue"),
    competitors: [
      ...canonical.competitors,
      ...competitors.map((/** @type {any} */ c) => ({
        ...c,
        observed_price_minor:
          c.observed_price_minor === null
            ? null
            : Number(c.observed_price_minor),
      })),
    ],
    availability:
      av.rows.find((/** @type {any} */ o) => o.storeId === store.id) ?? null,
    arScope: "Shared accounting account, not outlet-specific debt",
    demo:
      canonical.sample ||
      rows.some((/** @type {any} */ r) => r.source_type === "sample"),
  };
}
/** F-606 SEAM(INTEGRITY): findings are supplied, not detected or adjudicated here.
 * Every delivery/read reauthorizes current outlet/person ownership. Sample findings are labelled.
 * @param {any} ctx @param {any} p @param {any} s */
export async function fraudPage(ctx, p, s) {
  const rows =
    await ctx.db`with stores as materialized(select id,owner_unit_id,name from analytics_store_scope),people as materialized(select id,name,current_unit_id from analytics_people)
    select f.*,o.name outlet_name,pe.name person_name from analytics_integrity_findings f
    left join stores o on o.id=f.outlet_id left join people pe on pe.id=f.profile_id
    where f.org_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])}
    and (f.outlet_id is null or o.owner_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])})
    and (f.profile_id is null or pe.current_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])})
    and (${s.ownProfileId}::uuid is null or f.profile_id=${s.ownProfileId})
    and (f.occurred_at at time zone 'Asia/Manila')::date between ${p.from} and ${p.to}
    and (${p.channel}::text is null or exists(select 1 from analytics_store_scope outlet where outlet.id=f.outlet_id and outlet.channel=${p.channel}))
    order by case severity when 'high' then 0 when 'medium' then 1 else 2 end,f.occurred_at desc,f.id`;
  const canonicalSignals = [];
  if (roleHas(ctx.actor.role, "integrity.read")) {
    const [has] =
      await ctx.db`select id from integrity_findings where org_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])} and (occurred_at at time zone 'Asia/Manila')::date between ${p.from} and ${p.to} limit 1`;
    if (has) {
      let after = null;
      for (let page = 0; page < 100; page++) {
        const url = new URL(ctx.url);
        url.searchParams.set("from", p.from);
        url.searchParams.set("to", p.to);
        if (after) url.searchParams.set("after", after);
        else url.searchParams.delete("after");
        const queue = await readQueue({ ...ctx, url });
        for (const item of queue.items) {
          const [source] =
            await ctx.db`select f.*,v.effective_from as policy_effective_from,exists(select 1 from sample_data_rows m where m.table_name='integrity_findings' and m.row_id=f.id::text) sample
            from integrity_findings f join integrity_policy_versions v on v.id=f.policy_id left join analytics_store_scope o on o.id=f.outlet_id
            where f.id=${item.id} and f.org_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])}
            and (${s.ownProfileId ?? null}::uuid is null or f.profile_id=${s.ownProfileId ?? null}) and (${p.channel}::text is null or o.channel=${p.channel})`;
          if (source)
            canonicalSignals.push({
              id: item.id,
              title: item.rule.replaceAll("_", " "),
              detail:
                "Canonical Integrity signal — independent review required",
              storeId: source.outlet_id,
              store: item.outlet ?? "No outlet",
              person: item.person,
              severity: item.severity,
              status:
                item.disposition?.outcome === "false_positive"
                  ? "dismissed"
                  : item.disposition?.outcome === "confirmed"
                    ? "confirmed"
                    : item.disposition
                      ? "reviewing"
                      : "open",
              rule: item.rule,
              version: new Date(source.policy_effective_from).toISOString(),
              evidence: item.evidence,
              sample: source.sample,
              reviewHref: "/field-integrity",
            });
        }
        if (canonicalSignals.length > 500)
          throw new ApiError(
            "too_many_rows",
            422,
            "Narrow the integrity reporting period",
          );
        after = queue.next;
        if (!after) break;
        if (page === 99)
          throw new ApiError(
            "too_many_rows",
            422,
            "Narrow the integrity reporting period",
          );
      }
    }
  }
  return {
    definitionVersion: "commercial/v1",
    demo:
      canonicalSignals.some((r) => r.sample) ||
      rows.some((/** @type {any} */ r) => r.source_type === "sample"),
    rows: [
      ...canonicalSignals,
      ...rows.map((/** @type {any} */ r) => ({
        id: r.id,
        title: r.title,
        detail: r.detail,
        storeId: r.outlet_id,
        store: r.outlet_name ?? "No outlet",
        person: r.person_name ?? "Team",
        severity: r.severity,
        status: r.status,
        rule: r.rule_code,
        version: r.rule_version,
        evidence: r.evidence,
        sample: r.source_type === "sample",
        reviewHref:
          r.review_href.startsWith("/") && !r.review_href.startsWith("//")
            ? r.review_href
            : "/decide",
      })),
    ],
    notice:
      "Signals for independent review, not findings of guilt. Detection and disposition belong to Integrity.",
  };
}
/** F-602: effective policy and denominator weights editable in the existing office workspace.
 * @param {any} router @param {any} installCtx */
export function installPolicies(router, installCtx) {
  router.get("/api/v1/analytics/policies", async (/** @type {any} */ ctx) => {
    const s = await scopeFor(ctx);
    const rows =
      await ctx.db`select p.*,u.name unit from analytics_cockpit_policies p join org_units u on u.id=p.org_unit_id where org_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])} order by effective_from desc`;
    return { rows };
  });
  router.post(
    "/api/v1/analytics/policies/set",
    async (/** @type {any} */ ctx) => {
      await requireCapability(ctx, "target.manage");
      const s = await scopeFor(ctx),
        b = inputObject(ctx.body);
      if (
        !s.ids.includes(b.unitId) ||
        !Number.isInteger(b.freshnessDays) ||
        b.freshnessDays < 1 ||
        b.freshnessDays > 90
      )
        throw new ApiError(
          "invalid_policy",
          400,
          "Choose an allowed team and freshness from one to 90 days.",
        );
      const at = new Date(b.effectiveFrom);
      if (!Number.isFinite(at.getTime()) || at.getTime() < ctx.now)
        throw new ApiError(
          "invalid_effective_date",
          400,
          "Choose a future effective instant.",
        );
      await tx(ctx.db, async (db) => {
        await db`select pg_advisory_xact_lock(hashtext(${b.unitId + ":availability-policy"}))`;
        await db`update analytics_cockpit_policies set effective_to=${at},updated_at=now() where org_unit_id=${b.unitId} and effective_from<${at} and (effective_to is null or effective_to>${at})`;
        await db`insert into analytics_cockpit_policies(org_unit_id,freshness_days,effective_from,source_ref) values(${b.unitId},${b.freshnessDays},${at},'office:policy')`;
        await db`insert into audit_logs(subject,action,entity_type,entity_id) values(${ctx.actor.subject},'analytics.policy_set','org_unit',${b.unitId})`;
      });
      await installCtx.publish("analytics");
      return { ok: true };
    },
  );
  router.post(
    "/api/v1/analytics/turnover/set",
    async (/** @type {any} */ ctx) => {
      await requireCapability(ctx, "target.manage");
      const s = await scopeFor(ctx),
        b = inputObject(ctx.body),
        [store] =
          await ctx.db`select id,owner_unit_id from analytics_store_scope where id=${uuidInput(b.storeId)}`;
      if (!store || !s.ids.includes(store.owner_unit_id))
        throw new ApiError(
          "out_of_scope",
          403,
          "This store is outside your team.",
        );
      if (!Number.isSafeInteger(b.turnoverCentavos) || b.turnoverCentavos < 0)
        throw new ApiError(
          "invalid_weight",
          400,
          "Provide a non-negative turnover in centavos.",
        );
      const at = new Date(b.effectiveFrom);
      if (!Number.isFinite(at.getTime()) || at.getTime() < ctx.now)
        throw new ApiError(
          "invalid_effective_date",
          400,
          "Choose a future effective instant.",
        );
      await tx(ctx.db, async (db) => {
        await db`select pg_advisory_xact_lock(hashtext(${b.storeId + ":turnover"}))`;
        await db`update analytics_turnover_weights set effective_to=${at},updated_at=now() where outlet_id=${b.storeId} and effective_from<${at} and (effective_to is null or effective_to>${at})`;
        await db`insert into analytics_turnover_weights(outlet_id,turnover_centavos,effective_from,source_ref) values(${b.storeId},${b.turnoverCentavos},${at},'office:turnover')`;
        await db`insert into audit_logs(subject,action,entity_type,entity_id) values(${ctx.actor.subject},'analytics.turnover_set','outlet',${b.storeId})`;
      });
      await installCtx.publish("analytics");
      return { ok: true };
    },
  );
}
