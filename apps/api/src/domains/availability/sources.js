import { releasesAt } from "./masters.js";
import { resolveSet, stocking } from "./rules.js";
import { bounded, midnight } from "../fieldsync/model.js";
import { isUuid } from "../../core/util.js";

/** F-212/F-316: score the exact frozen checklist, not the superseded merchandising form.
 * An explicit incomplete new checklist supersedes an older complete one.
 * @param {any} db @param {any} visit */
export async function callAvailability(db, visit) {
  // Persisted legacy call IDs are text; only canonical UUIDs can match call_key.
  const [check] = isUuid(visit.client_visit_id)
    ? await db`select * from availability_checks where outlet_id=${visit.outlet_id}
    and profile_id=${visit.assignee_profile_id} and call_key=${visit.client_visit_id}
    and device_time>=${visit.checked_in_at} order by device_time desc,id desc limit 1`
    : [];
  if (check)
    return check.complete &&
      check.required_count > 0 &&
      check.checked_count === check.required_count
      ? {
          score: (100 * check.present_count) / check.required_count,
          sourceId: check.id,
          definitionVersion: "availability/2026-10-v1",
        }
      : null;
  const [legacy] =
    await db`select a.*,(select count(*)::int from merchandising_audit_missing_products m where m.merchandising_audit_id=a.id) missing
    from merchandising_audits a where a.visit_id=${visit.id} and a.deleted_at is null`;
  return legacy && legacy.required_count > 0 && legacy.missing === 0
    ? {
        score: (100 * legacy.required_available_count) / legacy.required_count,
        sourceId: legacy.id,
        definitionVersion: "legacy-merchandising/v1",
      }
    : null;
}

/** F-214/F-602: canonical MSL and shelf observations for every cockpit consumer.
 * Callers supply only currently authorized stores; source person AND stored scope are rechecked.
 * Legacy facts remain readable, but cannot override a newer canonical explicit unknown.
 * @param {any} db @param {any} p @param {any} s @param {any[]} stores @param {any[]} policies
 * @param {any[]} legacyAssigned @param {any[]} legacyObservations */
export async function availabilitySources(
  db,
  p,
  s,
  stores,
  policies,
  legacyAssigned,
  legacyObservations,
) {
  const at = midnight(p.to) + 86_400_000 - 1;
  const [framework, rules] = await Promise.all([
    releasesAt(db, "msl", at),
    releasesAt(db, "rules", at),
  ]);
  const canonicalPolicy = rules.length === 1 ? rules[0].payload : null;
  const ids = stores.map((o) => o.id);
  const outlets = ids.length
    ? await db`select o.*,exists(select 1 from sample_data_rows m where m.table_name='outlets' and m.row_id=o.id::text) is_sample
    from outlets o where o.id in ${db(ids)} and o.deleted_at is null`
    : [];
  const assigned = framework.length
    ? outlets.flatMap((/** @type {any} */ o) =>
        (resolveSet(o, framework)?.payload.lines ?? []).map(
          (/** @type {any} */ l) => ({
            outlet_id: o.id,
            product_id: l.productId,
          }),
        ),
      )
    : legacyAssigned;
  const checks = ids.length
    ? bounded(
        await db`select c.* from availability_checks c join analytics_people pe on pe.id=c.profile_id
    where c.outlet_id in ${db(ids)} and c.org_unit_id in ${db(s.ids.length ? s.ids : [null])}
    and pe.current_unit_id in ${db(s.ids.length ? s.ids : [null])}
    and (${s.ownProfileId ?? null}::uuid is null or c.profile_id=${s.ownProfileId ?? null})
    and c.device_time<=${new Date(at)} order by c.device_time desc,c.id desc limit 30001`,
        30000,
      )
    : [];
  const observations = new Map();
  for (const c of checks) {
    const store = stores.find((o) => o.id === c.outlet_id);
    const days =
      canonicalPolicy?.freshnessDays ??
      policies.find((r) => r.org_unit_id === store?.owner_unit_id)
        ?.freshness_days;
    for (const l of c.lines) {
      const key = `${c.outlet_id}:${l.productId}`;
      if (observations.has(key)) continue;
      const fresh = days && at - +new Date(c.device_time) < days * 86_400_000;
      const stock = fresh ? stocking(l) : null;
      observations.set(key, {
        id: c.id,
        outlet_id: c.outlet_id,
        product_id: l.productId,
        service_date: c.service_date,
        assignee_profile_id: c.profile_id,
        status:
          stock === true
            ? "available"
            : stock === false
              ? "out_of_stock"
              : "not_checked",
        shelfPresent:
          fresh && l.state !== "not_checked" ? l.state === "present" : null,
        source: "availability",
        sourceId: c.id,
      });
    }
  }
  for (const row of legacyObservations) {
    const key = `${row.outlet_id}:${row.product_id}`;
    if (!observations.has(key)) observations.set(key, row);
  }
  return {
    assigned,
    observations: [...observations.values()],
    setupRequired: !canonicalPolicy && !policies.length,
  };
}
