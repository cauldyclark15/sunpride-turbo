import { ApiError } from "../../core/errors.js";
import { requireNationalScope } from "../../core/capabilities.js";
import { accessVisit } from "../visits/shared.js";
import {
  accessOutlet,
  bounded,
  canonicalJson,
  changed,
  date,
  invalid,
  scoped,
  seams,
  sha256Hex,
  uuid,
} from "./common.js";
import {
  currentMasters,
  equipmentAt,
  posmAt,
  masterById,
  policyAt,
} from "./masters.js";
/** @param {string} start */
export function weekEnd(start) {
  date(start);
  if (new Date(start).getUTCDay() !== 1)
    throw invalid("Choose the Monday of the reporting week");
  return new Date(Date.parse(start) + 7 * 86400000).toISOString().slice(0, 10);
}
/** F-316: complete observations only; absence is unknown, never a free perfect score.
 * @param {any} c @param {any} visit @param {any} policy */
export async function visitScore(c, visit, policy) {
  await accessVisit(c, visit);
  const audits = bounded(
    await c.db`select * from retail_execution_audits where visit_id=${visit.id} order by captured_at desc,id desc limit 501`,
  );
  const { outlet } = await accessOutlet(c, visit.outlet_id, "visit.read");
  const context = audits.find(
    (/** @type {any} */ a) => a.facts.scorecardContext,
  )?.facts.scorecardContext;
  const appliedOutlet = context
    ? {
        ...outlet,
        classification: context.outletClass,
        channel: context.channel,
      }
    : outlet;
  const equipment = await equipmentAt(
    c.db,
    visit.outlet_id,
    +new Date(visit.started_at ?? visit.checked_in_at),
  );
  const campaigns = await seams.campaigns(
    c,
    appliedOutlet,
    +new Date(visit.started_at ?? visit.checked_in_at),
  );
  /** @type {Record<string,any>} */ const values = {};
  values.availability = await seams.availability(c, visit);
  values.price = await seams.priceCompliance(c, visit, appliedOutlet);
  for (const kind of ["planogram"]) {
    const a = audits.find((/** @type {any} */ a) => a.kind === kind);
    values[kind] = a
      ? { score: Number(a.component_score), sourceId: a.id }
      : null;
  }
  const auditAt = visit.ended_at
    ? +new Date(visit.ended_at)
    : Math.max(
        +new Date(visit.started_at ?? visit.checked_in_at),
        ...audits.map((/** @type {any} */ a) => +new Date(a.captured_at)),
      );
  const deployed = await posmAt(
    c.db,
    { kind: "deploy", outletId: visit.outlet_id },
    auditAt,
  );
  const posmAudits = deployed.map((/** @type {any} */ unit) =>
    audits.find(
      (/** @type {any} */ a) =>
        a.kind === "posm" && a.facts.unitCode === unit.unit_code,
    ),
  );
  values.posm = !deployed.length
    ? { notApplicable: true }
    : posmAudits.every(Boolean)
      ? {
          score:
            posmAudits.reduce(
              (/** @type {number} */ n, /** @type {any} */ a) =>
                n + Number(a.component_score),
              0,
            ) / posmAudits.length,
          sourceIds: posmAudits.map((/** @type {any} */ a) => a.id),
        }
      : null;
  const freezers = equipment.map((/** @type {any} */ m) =>
    audits.find(
      (/** @type {any} */ a) =>
        a.kind === "freezer" && a.master_version_id === m.id,
    ),
  );
  values.freezer = !equipment.length
    ? { notApplicable: true }
    : freezers.every(Boolean)
      ? {
          score:
            freezers.reduce(
              (/** @type {number} */ n, /** @type {any} */ a) =>
                n + Number(a.component_score),
              0,
            ) / freezers.length,
          sourceIds: freezers.map((/** @type {any} */ a) => a.id),
        }
      : null;
  const promos = (campaigns ?? []).map((/** @type {any} */ m) =>
    audits.find(
      (/** @type {any} */ a) =>
        a.kind === "promotion" && a.facts.campaignVersionId === m.id,
    ),
  );
  values.promotion =
    campaigns === null
      ? null
      : !campaigns.length
        ? { notApplicable: true }
        : promos.every(Boolean)
          ? {
              score:
                promos.reduce(
                  (/** @type {number} */ n, /** @type {any} */ a) =>
                    n + Number(a.component_score),
                  0,
                ) / promos.length,
              sourceIds: promos.map((/** @type {any} */ a) => a.id),
            }
          : null;
  const components = policy.data.components.map((/** @type {any} */ p) => ({
    key: p.key,
    weight: p.weight,
    value: values[p.key] ?? null,
    status: values[p.key]?.notApplicable
      ? p.allowNotApplicable
        ? "not_applicable"
        : "missing"
      : values[p.key]
        ? "complete"
        : "missing",
  }));
  const missing = components
      .filter((/** @type {any} */ x) => x.status === "missing")
      .map((/** @type {any} */ x) => x.key),
    eligible = components.filter(
      (/** @type {any} */ x) => x.status === "complete",
    );
  const denominator = eligible.reduce(
    (/** @type {number} */ n, /** @type {any} */ x) => n + x.weight,
    0,
  );
  return {
    visitId: visit.id,
    outletId: visit.outlet_id,
    outletName: outlet.name,
    capturedAt: +new Date(visit.started_at ?? visit.checked_in_at),
    policyVersionId: policy.id,
    target: policy.data.targetPercent,
    components,
    missing,
    status: missing.length ? "incomplete" : "complete",
    score:
      !missing.length && denominator
        ? Math.round(
            (eligible.reduce(
              (/** @type {number} */ n, /** @type {any} */ x) =>
                n + x.weight * x.value.score,
              0,
            ) /
              denominator) *
              100,
          ) / 100
        : null,
  };
}
/** @param {any} c @param {string} customerId @param {string} start */
export async function accountWeek(c, customerId, start) {
  const end = weekEnd(start);
  const [account] =
    await c.db`select * from customers where id=${uuid(customerId)} and deleted_at is null`;
  if (!account) throw invalid("Choose an account");
  const outlets = await scoped(
    c,
    bounded(
      await c.db`select o.* from outlets o join outlet_customer_links l on l.outlet_id=o.id where l.customer_id=${account.id} and l.deleted_at is null and o.deleted_at is null and l.effective_from<=${new Date(c.now)} and (l.effective_to is null or l.effective_to>${new Date(c.now)}) order by o.name limit 501`,
    ),
    (r) => r.id,
  );
  if (!outlets.length) throw invalid("No accessible branches for this account");
  const scores = [];
  for (const outlet of outlets) {
    const [v] =
      await c.db`select v.* from visit_executions v where v.outlet_id=${outlet.id} and v.service_date>=${start} and v.service_date<${end} and v.deleted_at is null and v.checked_in_at is not null and (${c.actor.role !== "sales"} or v.assignee_profile_id=${c.actor.profileId}) and exists(select 1 from outlet_customer_links l where l.outlet_id=v.outlet_id and l.customer_id=${account.id} and l.deleted_at is null and l.effective_from<=v.checked_in_at and (l.effective_to is null or l.effective_to>v.checked_in_at)) order by v.checked_in_at desc,v.id desc limit 1`;
    const [recorded] = v
      ? await c.db`select facts->'scorecardContext' as context from retail_execution_audits where visit_id=${v.id} and facts ? 'scorecardContext' order by created_at,id limit 1`
      : [];
    const policy =
      v &&
      (recorded
        ? recorded.context.versionId
          ? await masterById(c.db, recorded.context.versionId, "scorecard")
          : null
        : await policyAt(
            c.db,
            "scorecard",
            outlet,
            +new Date(v.started_at ?? v.checked_in_at),
          ));
    if (v && policy) {
      try {
        scores.push(await visitScore(c, v, policy));
        continue;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 403)) throw e;
      }
    }
    scores.push({
      outletId: outlet.id,
      outletName: outlet.name,
      status: "incomplete",
      missing: [v && !policy ? "scorecard setup" : "authorized visit"],
      score: null,
      target: null,
    });
  }
  const complete = scores.filter((s) => s.status === "complete"),
    isComplete = complete.length === scores.length;
  return {
    accountId: account.id,
    accountName: account.name,
    weekStart: start,
    weekEnd: end,
    branches: scores,
    completeBranches: complete.length,
    totalBranches: scores.length,
    status: isComplete ? "complete" : "incomplete",
    score: isComplete
      ? Math.round(
          (complete.reduce((n, s) => n + Number(s.score), 0) /
            complete.length) *
            100,
        ) / 100
      : null,
  };
}
/** F-316 immutable weekly publication; only national office can publish an account-wide total.
 * @param {any} c */
export async function publishScore(c) {
  await requireNationalScope(c, ["super_admin", "admin", "operations"]);
  const b = c.body,
    snapshot = await accountWeek(c, uuid(b.customerId), date(b.weekStart));
  if (
    snapshot.weekEnd > new Date(c.now + 8 * 3600000).toISOString().slice(0, 10)
  )
    throw invalid("Publish completed weeks only");
  const firstPolicyId = snapshot.branches
    .map((/** @type {any} */ r) => r.policyVersionId)
    .find(Boolean);
  const publicationPolicy = firstPolicyId
    ? await masterById(c.db, firstPolicyId, "scorecard")
    : (await currentMasters(c.db, "scorecard", c.now)).find(
        (/** @type {any} */ r) => r.outlet_class === "*",
      );
  if (!publicationPolicy) throw invalid("Set a scorecard publication policy");
  await c.db`select pg_advisory_xact_lock(hashtextextended(${`score:${b.customerId}:${b.weekStart}`},0))`;
  const hash = sha256Hex(canonicalJson(snapshot));
  const [last] =
    await c.db`select * from perfect_store_publications where customer_id=${b.customerId} and week_start=${b.weekStart} order by revision desc limit 1`;
  if (last?.content_hash === hash)
    return { id: last.id, snapshot: last.snapshot };
  const [r] =
    await c.db`insert into perfect_store_publications(week_start,customer_id,scorecard_version_id,revision,content_hash,snapshot,actor_subject) values(${b.weekStart},${b.customerId},${publicationPolicy.id},${(last?.revision ?? 0) + 1},${hash},${snapshot},${c.actor.subject}) returning id`;
  await changed(c, "score.published", r.id);
  return { id: r.id, snapshot };
}
