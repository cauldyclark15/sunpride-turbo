import { requireCapability } from "../../core/capabilities.js";
import { invalid } from "../../core/errors.js";
import { uuid, text, refuse } from "./model.js";
import { audit } from "./facts.js";

/** F-115/F-118/F-114/F-113: validate editable, versioned operational policy. @param {string} kind @param {any} facts */
export function validatePolicy(kind, facts) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts))
    throw invalid("Policy details are required");
  const whole = (
    /** @type {any} */ n,
    /** @type {number} */ min,
    /** @type {number} */ max,
  ) => {
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw invalid("Policy value is outside the supported range");
  };
  if (kind === "cold_chain") {
    whole(facts.intervalMinutes, 1, 240);
    if (
      !Array.isArray(facts.bands) ||
      !facts.bands.length ||
      facts.bands.length > 500
    )
      throw invalid("Supply storage bands");
    const seen = new Set();
    for (const band of facts.bands) {
      if (band.productId !== null) uuid(band.productId);
      if (seen.has(band.productId))
        throw invalid("A product has more than one storage band");
      seen.add(band.productId);
      text(band.label, 80, true);
      whole(band.minDeciC, -1000, 600);
      whole(band.maxDeciC, -1000, 600);
      if (band.minDeciC >= band.maxDeciC)
        throw invalid("Storage minimum must be below maximum");
    }
  } else if (kind === "variance") {
    whole(facts.toleranceBasisPoints, 0, 10000);
    whole(facts.escalateAfterHours, 1, 168);
  } else if (kind === "returnables" || kind === "return_reasons") {
    if (
      !Array.isArray(facts.items) ||
      !facts.items.length ||
      facts.items.length > 30
    )
      throw invalid("Supply a controlled list");
    const seen = new Set();
    for (const item of facts.items) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(item.code) || seen.has(item.code))
        throw invalid("Use unique reason or asset codes");
      seen.add(item.code);
      text(item.label, 80, true);
    }
  } else throw invalid("Unknown van policy");
  return facts;
}

/** @param {any} db @param {any} trip @param {string} kind @param {number} at */
export async function routePolicy(db, trip, kind, at) {
  const rows =
    await db`select * from van_policy_versions where org_unit_id=${trip.org_unit_id} and kind=${kind} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
  if (rows.length !== 1)
    refuse(
      "Set up the van's effective operational policy before the route",
      "invalid_request",
    );
  return rows[0];
}

/** F-115/F-118: replace prospectively; already captured readings retain their original policy. @param {any} db @param {any} actor @param {any} p */
export async function setRoutePolicy(db, actor, p) {
  const unit = uuid(p.orgUnitId),
    kind = String(p.kind),
    facts = validatePolicy(kind, p.facts);
  await requireCapability({ db, actor }, "van.manage", unit);
  const from = new Date(p.effectiveFrom);
  if (!Number.isFinite(from.getTime()) || from.getTime() < Date.now())
    throw invalid("Choose a future policy start time");
  const source = text(p.sourceRef, 200, true);
  await db`select pg_advisory_xact_lock(hashtextextended(${unit + ":" + kind},0))`;
  if (
    (
      await db`select 1 from van_policy_versions where org_unit_id=${unit} and kind=${kind} and effective_from>=${from}`
    ).length
  )
    throw invalid("A future policy version already exists");
  await db`update van_policy_versions set effective_to=${from},updated_at=now() where org_unit_id=${unit} and kind=${kind} and effective_to is null`;
  const [row] =
    await db`insert into van_policy_versions(org_unit_id,kind,effective_from,source_ref,facts,created_by) values(${unit},${kind},${from},${source},${facts},${actor.profileId}) returning id`;
  await audit(db, null, actor, "van.policy.version", row.id, {
    kind,
    orgUnitId: unit,
  });
  return { policyId: row.id };
}

/** F-115: all loaded governed products must be within their individual storage bands. @param {any} policy @param {number} deciC @param {string[]} productIds */
export function temperatureAssessment(policy, deciC, productIds) {
  validatePolicy("cold_chain", policy);
  if (!Number.isSafeInteger(deciC) || deciC < -1000 || deciC > 600)
    throw invalid(
      "Use a temperature between −100 and 60 °C, to one decimal place",
    );
  const bands = productIds.length
    ? productIds.map(
        (id) =>
          policy.bands.find((/** @type {any} */ b) => b.productId === id) ??
          policy.bands.find((/** @type {any} */ b) => b.productId === null),
      )
    : policy.bands.filter((/** @type {any} */ b) => b.productId === null);
  if (!bands.length)
    throw invalid("An empty load still needs a van storage band");
  if (bands.some((/** @type {any} */ b) => !b))
    throw invalid("A loaded product has no approved storage band");
  return {
    excursion: bands.some(
      (/** @type {any} */ b) => deciC < b.minDeciC || deciC > b.maxDeciC,
    ),
    bands,
  };
}
