import {
  equipmentAt,
  posmAt,
  policyAt,
  masterById,
} from "../retail/masters.js";
import { visitScore } from "../retail/scoring.js";
import { bounded } from "../fieldsync/model.js";

/** F-604: read the merged retail/master authorities. Caller already authorizes current store ownership.
 * Evidence still checks its own stored and current person scope; no shared-account shortcut.
 * @param {any} db @param {any} p @param {any} s @param {any} store @param {any} [ctx] */
export async function canonicalOutletContext(db, p, s, store, ctx) {
  const at = +new Date(p.to + "T23:59:59.999+08:00");
  const [outlet] =
    await db`select classification,sales_potential from outlets where id=${store.id} and deleted_at is null`;
  const equipment = await equipmentAt(db, store.id, at);
  const posm = await posmAt(db, { kind: "deploy", outletId: store.id }, at);
  const visits = bounded(
    await db`select v.* from visit_executions v join analytics_people pe on pe.id=v.assignee_profile_id
    where v.outlet_id=${store.id} and v.deleted_at is null and v.org_unit_id in ${db(s.ids.length ? s.ids : [null])}
    and pe.current_unit_id in ${db(s.ids.length ? s.ids : [null])}
    and (${s.ownProfileId ?? null}::uuid is null or v.assignee_profile_id=${s.ownProfileId ?? null})
    and v.service_date between ${p.from} and ${p.to} order by v.service_date desc,v.checked_in_at desc,v.id desc limit 501`,
    500,
  );
  const ids = visits.map((/** @type {any} */ v) => v.id);
  const audits = ids.length
    ? bounded(
        await db`select * from retail_execution_audits where visit_id in ${db(ids)} order by captured_at desc,id desc limit 501`,
        500,
      )
    : [];
  const cases = ids.length
    ? bounded(
        await db`select c.* from retail_action_cases c join retail_execution_audits a on a.id=c.audit_id where a.visit_id in ${db(ids)} and c.outlet_id=${store.id} order by c.due_at,c.id limit 501`,
        500,
      )
    : [];
  const assets = [];
  for (const e of equipment) {
    const service = bounded(
      await db`select kind,reference,note,occurred_at from equipment_service_events where equipment_version_id=${e.id} and occurred_at<=${new Date(at)} order by occurred_at desc,id desc limit 501`,
      500,
    );
    const audit = audits.find(
      (/** @type {any} */ a) =>
        a.kind === "freezer" && a.master_version_id === e.id,
    );
    assets.push({
      label: e.label,
      serial: e.data.serial,
      condition: audit
        ? `${audit.component_score}% agreement compliance`
        : "Audit not recorded",
      service: service[0]
        ? `${service[0].kind}: ${service[0].reference}`
        : "No service recorded",
      history: `${service.length} recorded service events`,
      source: {
        system: "retail",
        key: e.id,
        revision: e.version,
        sample: e.source === "sample",
      },
    });
  }
  for (const material of posm)
    assets.push({
      label: `POSM · ${material.unit_code}`,
      serial: material.unit_code,
      condition: "Deployed",
      service: null,
      history: material.reason,
      source: { system: "retail", key: material.id },
    });
  let executionScore = null;
  if (ctx && visits[0]) {
    const first = audits
      .filter((/** @type {any} */ a) => a.visit_id === visits[0].id)
      .at(-1);
    const frozen = first?.facts.scorecardContext;
    const policy = frozen?.versionId
      ? await masterById(db, frozen.versionId, "scorecard")
      : await policyAt(
          db,
          "scorecard",
          store,
          +new Date(visits[0].checked_in_at),
        );
    if (policy) {
      const score = await visitScore({ ...ctx, db }, visits[0], policy);
      executionScore = {
        value: score.score,
        reason: score.missing.length
          ? `Missing: ${score.missing.join(", ")}`
          : "Complete governed retail score",
        components: Object.fromEntries(
          score.components.map((/** @type {any} */ c) => [
            c.key,
            c.value?.score ?? null,
          ]),
        ),
        source: {
          system: "retail",
          key: visits[0].id,
          revision: policy.version,
        },
      };
    }
  }
  return {
    classification: outlet?.classification
      ? {
          label: `Class ${outlet.classification}`,
          potential: outlet.sales_potential,
          source: { system: "masters" },
        }
      : null,
    executionScore,
    assets,
    issues: cases.map((/** @type {any} */ c) => ({
      label: c.kind.replaceAll("_", " "),
      status: c.status,
      nextAction:
        c.status === "awaiting_sap"
          ? "Follow up SAP instruction"
          : ["resolved", "rejected"].includes(c.status)
            ? "No open action"
            : "Open Retail execution to assign or resolve",
      source: { system: "retail", key: c.id },
    })),
    competitors: audits
      .filter(
        (/** @type {any} */ a) =>
          a.kind === "competitor" && !a.facts.noneObserved,
      )
      .map((/** @type {any} */ a) => ({
        id: a.id,
        brand: a.facts.brand,
        kind: a.facts.type,
        observed_price_minor: a.facts.priceCentavos ?? null,
        note: a.facts.note ?? a.facts.description ?? null,
      })),
    hasExecution: audits.length > 0,
    sample: equipment.some((/** @type {any} */ e) => e.source === "sample"),
  };
}
