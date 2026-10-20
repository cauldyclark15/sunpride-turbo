import { hooks } from "./hooks.js";
import { canonicalJson, sha256Hex } from "./util.js";
import {
  partnerContext,
  partnerStoreGrants,
} from "../domains/partners/boundary.js";

/**
 * Device-independent sync scope for an actor. `id` is what clients echo as `scopeId`;
 * `fingerprint` changes whenever person, subject, unit, role or authorization epoch changes.
 * @param {import('@sunpride/db/client').Db} db
 * @param {import('./context.js').Actor} actor
 */
export async function scopeOf(db, actor) {
  const partner = await partnerContext(db, actor);
  const assignments = partner ? await partnerStoreGrants(db, partner) : [];
  const fingerprint = sha256Hex(
    [
      actor.profileId,
      actor.subject,
      actor.orgUnitId ?? "",
      actor.role,
      actor.scopeEpoch ?? "",
      ...(partner
        ? [
            canonicalJson({
              id: partner.id,
              partnerId: partner.distributor_id,
              grants: partner.grants,
              until: partner.effective_to,
              assignments,
            }),
          ]
        : []),
    ].join("|"),
  );
  return {
    id: actor.orgUnitId ?? "unscoped",
    fingerprint,
    epoch: actor.scopeEpoch ?? fingerprint.slice(0, 16),
    orgUnitIds: await hooks.scopeUnitIds(db, actor),
  };
}

/**
 * Next 22:00 Manila day close strictly after `now` (offline lease/cache expiry).
 * Manila is UTC+8 with no DST, so 22:00 local = 14:00 UTC.
 * @param {number} now
 */
export function nextDayClose(now) {
  const d = new Date(now);
  let close = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    14,
    0,
    0,
    0,
  );
  if (close <= now) close += 24 * 60 * 60 * 1000;
  return close;
}
