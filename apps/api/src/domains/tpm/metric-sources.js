import { canonicalJson, sha256Hex } from "../../core/util.js";
import { periodFor, scopeFor, readSales } from "../analytics/measures.js";
import {
  readVisits,
  visitSummary,
  readCollections,
} from "../analytics/data.js";
import { availabilityModel } from "../analytics/availability-adapter.js";
import { targetFor } from "../analytics/targets.js";
import { fail } from "../orders/validation.js";

/** F-510 canonical office metrics; the plan can explicitly supply a governed target, not caller actuals.
 * Each source is the same currently authorized source used by the tower. No fabricated KPI snapshots.
 * @param {any} c @param {any} q @returns {Promise<any>} */
export async function readIncentiveMetrics(c, q) {
  const url = new URL("http://metrics.local");
  url.searchParams.set("from", q.periodFrom);
  url.searchParams.set("to", q.periodTo);
  const local = { ...c, url },
    p = periodFor(local),
    s = { ...(await scopeFor(local)), ownProfileId: q.profileId };
  const [person] =
    await c.db`select p.id,p.org_unit_id,p.auth_subject,p.user_id from profiles p join org_units u on u.id=p.org_unit_id and u.organization_id='sunpride' where p.id=${q.profileId} and p.status='active' and p.deleted_at is null`;
  if (!person || !s.ids.includes(person.org_unit_id))
    fail("Employee is outside the current metric scope");
  const rules = q.rules ?? [],
    wanted = new Set(
      rules
        .filter((/** @type {any} */ r) => r.weightBps > 0)
        .map((/** @type {any} */ r) => r.metric),
    );
  /** @type {Record<string,any>} */ const metrics = {};
  const fact = (
    /** @type {string} */ metric,
    /** @type {number|null} */ actual,
    /** @type {number|null} */ target,
    /** @type {string} */ version,
  ) => {
    const rule = rules.find((/** @type {any} */ r) => r.metric === metric);
    metrics[metric] = {
      actual,
      target: rule?.target ?? target,
      definitionVersion: version,
      targetSource:
        rule?.target != null
          ? "effective incentive plan"
          : "canonical source target",
    };
  };
  if (wanted.has("targets")) {
    const sales = await readSales(c.db, p, s);
    const [unknown] =
      await c.db`select exists(select 1 from orders where (salesperson_profile_id=${q.profileId} or salesperson_subject=${person.auth_subject} or salesperson_subject=${person.user_id ?? ""}) and coalesce(service_date,(coalesce(offline_created_at,created_at) at time zone 'Asia/Manila')::date) between ${p.from} and ${p.to} and deleted_at is null and status not in ('draft','rejected','voided') and not amount_known) as present`;
    const target = await targetFor(c.db, s, p, "agent", q.profileId);
    fact(
      "targets",
      unknown.present ? null : Number(sales.total?.sales ?? 0),
      target,
      "commercial/v1:booked-net-sales-centavos",
    );
  }
  if (wanted.has("coverage")) {
    const visits = visitSummary(await readVisits(c.db, p, s));
    fact(
      "coverage",
      visits.visited,
      visits.planned,
      "coverage/v1:approved-plan-completed-calls",
    );
  }
  if (wanted.has("availability") || wanted.has("distribution")) {
    const av = await availabilityModel(c.db, p, s);
    fact(
      "availability",
      av.osa == null ? null : Math.round(av.osa * 100),
      10000,
      "availability/2026-10-v1:osa-basis-points",
    );
    const universe = av.distribution.reduce(
      (/** @type {number} */ n, /** @type {any} */ r) => n + r.universe,
      0,
    );
    const stocked = av.distribution.reduce(
      (/** @type {number} */ n, /** @type {any} */ r) => n + r.stocking,
      0,
    );
    fact(
      "distribution",
      universe &&
        av.distribution.every((/** @type {any} */ r) => r.unmeasured === 0)
        ? Math.round((stocked * 10000) / universe)
        : null,
      10000,
      "availability/2026-10-v1:sku-store-numeric-distribution-bps",
    );
  }
  if (wanted.has("collection")) {
    const rows = await readCollections(c.db, p, s);
    fact(
      "collection",
      rows.reduce(
        (/** @type {number} */ n, /** @type {any} */ r) =>
          n + Number(r.amount_minor),
        0,
      ),
      null,
      "collections/v1:recorded-field-and-van-centavos",
    );
  }
  if (wanted.has("settlementVariance")) {
    const trips =
      await c.db`select t.id,t.status,s.id as settlement_id,s.facts->>'varianceCentavos' as variance,d.decision from van_trips t left join lateral(select id,facts from van_settlements where trip_id=t.id order by version desc limit 1)s on true left join van_settlement_decisions d on d.settlement_id=s.id where t.salesperson_profile_id=${q.profileId} and t.org_unit_id in ${c.db(s.ids)} and t.service_date between ${p.from} and ${p.to} and t.status<>'cancelled' and t.deleted_at is null`;
    const complete =
      trips.length > 0 &&
      trips.every(
        (/** @type {any} */ t) =>
          t.status === "closed" &&
          t.decision === "approved" &&
          t.variance != null,
      );
    fact(
      "settlementVariance",
      complete
        ? trips.reduce(
            (/** @type {number} */ n, /** @type {any} */ t) =>
              n + Math.abs(Number(t.variance)),
            0,
          )
        : null,
      null,
      "vanops/v1:approved-settlement-absolute-cash-variance-centavos",
    );
  }
  const sourceHash = sha256Hex(
    canonicalJson({ profileId: q.profileId, from: p.from, to: p.to, metrics }),
  );
  return {
    metrics,
    sourceKey: `incentive-canonical:v1:${sourceHash}`,
    definitionVersion: "incentive-canonical/v1",
  };
}
