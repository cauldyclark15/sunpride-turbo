import { tx } from "@sunpride/db/client";
import { forbidden, invalid, conflict } from "../../core/errors.js";
import { scopeFilterForActor, outletOwnerUnit } from "../org/scope.js";
import { requireCapability } from "../../core/capabilities.js";
import { haversine } from "../visits/location.js";
import { isUuid } from "../../core/util.js";
import { accessibleOrder } from "../orders/access.js";
import { tripFor } from "../van/access.js";

/** @param {any} db @param {number} [at] */
export async function policyAt(db, at = Date.now()) {
  const rows =
    await db`select * from integrity_policy_versions where code='field-integrity' and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
  if (rows.length !== 1) throw conflict("Integrity policy needs setup");
  return rows[0];
}
/** SEAM(CALLFLOW): consume this single decision, never build another call flow.
 * F-024: mock fixes refuse check-in; travel flags require office investigation, not automatic guilt.
 * @param {any} ctx @param {any} payload */
export async function evaluateCheckInIntegrity(ctx, payload) {
  const policy = await policyAt(ctx.db),
    flags = [];
  if (payload.location?.mockSignal === true) flags.push("mock_location");
  const fix = payload.location;
  if (validFix(fix)) {
    const [prev] =
      await ctx.db`select * from integrity_observations where profile_id=${ctx.actor.profileId} and kind='check_in'
      and occurred_at<${new Date(payload.deviceTime)} order by occurred_at desc,id desc limit 1`;
    if (
      prev &&
      travel(
        prev.facts,
        fix,
        payload.deviceTime - new Date(prev.occurred_at).getTime(),
        policy.settings,
      )
    )
      flags.push("impossible_travel");
  }
  return {
    allowed: !flags.includes("mock_location"),
    flags,
    policyId: policy.id,
    attestation: "os_signals_not_hardware_verified",
  };
}
/** @param {any} f */
export function validFix(f) {
  return (
    f &&
    Number.isFinite(f.latitude) &&
    Math.abs(f.latitude) <= 90 &&
    Number.isFinite(f.longitude) &&
    Math.abs(f.longitude) <= 180 &&
    Number.isFinite(f.accuracyMeters) &&
    f.accuracyMeters >= 0
  );
}
/** @param {any} a @param {any} b @param {number} dt @param {any} settings */
export function travel(a, b, dt, settings) {
  if (!validFix(a) || !validFix(b) || dt <= 0 || dt > 24 * 3600_000)
    return null;
  const meters = Math.max(
    0,
    haversine(a, b) -
      a.accuracyMeters -
      b.accuracyMeters -
      settings.travelToleranceMeters,
  );
  const kph = (meters / dt) * 3600;
  return kph > settings.maxTravelKph
    ? {
        speedKph: Math.round(kph),
        distanceMeters: Math.round(meters),
        elapsedMs: dt,
      }
    : null;
}
/** @param {string} a @param {string} b */
export function hamming(a, b) {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 65;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`),
    n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}
/** F-221: persist attempts OUTSIDE the refused business transaction. No refused visit is invented.
 * @param {any} ctx @param {any[]} operations */
export async function observePush(ctx, operations) {
  for (const op of operations) {
    if (
      op.opType !== "visit.checkIn" ||
      !Number.isSafeInteger(op.payload?.deviceTime) ||
      Math.abs(op.payload.deviceTime - Date.now()) > 7 * 86400_000
    )
      continue;
    const p = op.payload;
    if (!validFix(p.location) && p.location != null) continue;
    const owner =
      typeof p.outletId === "string"
        ? await outletOwnerUnit(ctx.db, p.outletId, Date.now()).catch(
            () => null,
          )
        : null;
    if (owner !== ctx.actor.orgUnitId) continue;
    await ctx.db`insert into integrity_observations(source_key,kind,profile_id,org_unit_id,device_id,outlet_id,occurred_at,facts)
      values (${`checkin:${ctx.device.id}:${op.clientOpId}`},'check_in',${ctx.actor.profileId},${ctx.actor.orgUnitId},${ctx.device.id},${p.outletId},${new Date(p.deviceTime)},${{ ...p.location, receivedAt: Date.now(), clientOpId: op.clientOpId }}) on conflict(source_key) do nothing`;
  }
}
/** @param {any} t @param {any} o @param {any} p @param {string} rule @param {any} evidence @param {string|null} runId */
async function finding(t, o, p, rule, evidence, runId) {
  const rows =
    await t`insert into integrity_findings(rule,source_key,policy_id,run_id,profile_id,org_unit_id,device_id,outlet_id,evidence,severity,occurred_at)
    values (${rule},${o.source_key},${p.id},${runId},${o.profile_id},${o.org_unit_id},${o.device_id ?? null},${o.outlet_id ?? null},${evidence},${rule === "mock_location" || rule === "impossible_travel" ? "high" : "medium"},${o.occurred_at})
    on conflict(rule,source_key,policy_id) do nothing returning id`;
  return rows.length;
}
/** F-221/F-606: bounded, replay-safe job, with a durable keyset cursor (no prefix starvation).
 * @param {any} db @param {{reset?:boolean}} [opts] */
export async function detect(db, opts = {}) {
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(hashtext('integrity-detectors-v1'))`;
    const p = await policyAt(t),
      s = p.settings;
    const [run] =
      await t`insert into integrity_runs(policy_id) values (${p.id}) returning id`;
    const [cursor] =
      await t`select * from integrity_detector_cursors where policy_id=${p.id} for update`;
    const rows =
      await t`select * from integrity_observations where ${opts.reset === true} or ${!cursor} or (created_at,id)>(select last_created_at,last_id from integrity_detector_cursors where policy_id=${p.id}) order by created_at,id limit 500`;
    let n = 0;
    for (const o of rows) {
      const f = o.facts;
      // F-221: phone refusals enter the mock denominator, never travel/visit/batch facts.
      if (o.kind === "refused_check_in" && f.mockSignal === true)
        n += await finding(
          t,
          o,
          p,
          "mock_location",
          { mock: true, refusedOnPhone: true },
          run.id,
        );
      if (o.kind === "check_in") {
        if (f.mockSignal === true)
          n += await finding(
            t,
            o,
            p,
            "mock_location",
            { mock: true, clientOpId: f.clientOpId },
            run.id,
          );
        // Evaluate both neighbors, so a delayed offline observation still catches a teleport.
        const neighbors =
          await t`(select * from integrity_observations where kind='check_in' and profile_id=${o.profile_id} and (occurred_at,id)<(${o.occurred_at},${o.id}) order by occurred_at desc,id desc limit 1)
          union all (select * from integrity_observations where kind='check_in' and profile_id=${o.profile_id} and (occurred_at,id)>(${o.occurred_at},${o.id}) order by occurred_at,id limit 1)`;
        for (const other of neighbors) {
          const dt = Math.abs(
            new Date(o.occurred_at).getTime() -
              new Date(other.occurred_at).getTime(),
          );
          const impossible = travel(f, other.facts, dt || 1, s);
          if (impossible)
            n += await finding(
              t,
              o,
              p,
              "impossible_travel",
              { ...impossible, relatedObservation: other.id },
              run.id,
            );
        }
        const [{ count }] =
          await t`select count(*)::int as count from integrity_observations where kind='check_in' and profile_id=${o.profile_id} and occurred_at between ${new Date(new Date(o.occurred_at).getTime() - s.batchWindowMs)} and ${o.occurred_at}`;
        if (count >= s.batchCount)
          n += await finding(
            t,
            o,
            p,
            "batch_checkins",
            { count, windowMs: s.batchWindowMs },
            run.id,
          );
      }
      if (o.kind === "photo") {
        if (f.exifMismatch === true)
          n += await finding(
            t,
            o,
            p,
            "exif_mismatch",
            { reasons: f.exifReasons },
            run.id,
          );
        const other =
          await t`select id,source_key,facts from integrity_observations where kind='photo' and id<>${o.id} and (created_at,id)<(select created_at,id from integrity_observations where id=${o.id}) and occurred_at>=${new Date(new Date(o.occurred_at).getTime() - 90 * 86400_000)} order by created_at desc,id desc limit 1001`;
        if (other.length > 1000)
          n += await finding(
            t,
            o,
            p,
            "photo_comparison_overflow",
            { compared: 1000, incomplete: true },
            run.id,
          );
        for (const a of other.slice(0, 1000)) {
          if (a.facts.checksum === f.checksum)
            n += await finding(
              t,
              o,
              p,
              "duplicate_photo",
              { relatedObservation: a.id, match: "exact" },
              run.id,
            );
          else if (
            hamming(f.perceptualHash ?? "", a.facts.perceptualHash ?? "") <=
            s.perceptualHamming
          )
            n += await finding(
              t,
              o,
              p,
              "similar_photo",
              {
                relatedObservation: a.id,
                match: "device-supplied-dhash",
                unverified: true,
              },
              run.id,
            );
        }
      }
      if (o.kind === "order") {
        const [{ count }] =
          await t`select count(distinct coalesce(facts->>'orderId',source_key))::int as count from integrity_observations where kind='order' and profile_id=${o.profile_id} and facts->>'customerCode'=${f.customerCode} and facts->>'totalCentavos'=${String(f.totalCentavos)} and occurred_at between ${new Date(new Date(o.occurred_at).getTime() - s.batchWindowMs)} and ${o.occurred_at}`;
        if (count >= s.orderRepeatCount)
          n += await finding(
            t,
            o,
            p,
            "repeat_orders",
            { count, totalCentavos: f.totalCentavos },
            run.id,
          );
      }
      if (o.kind === "discount" && f.ratePct >= s.discountRatePct)
        n += await finding(
          t,
          o,
          p,
          "high_discount",
          { ratePct: f.ratePct },
          run.id,
        );
      if (o.kind === "return" && f.returnRatioPct >= s.returnRatioPct)
        n += await finding(
          t,
          o,
          p,
          "high_returns",
          { returnRatioPct: f.returnRatioPct, saleId: f.saleId },
          run.id,
        );
      if (
        o.kind === "settlement" &&
        Math.abs(f.varianceCentavos) >= s.settlementVarianceCentavos
      )
        n += await finding(
          t,
          o,
          p,
          "settlement_variance",
          { varianceCentavos: f.varianceCentavos, tripId: f.tripId },
          run.id,
        );
    }
    const last = rows.at(-1);
    if (last)
      await t`insert into integrity_detector_cursors(policy_id,last_created_at,last_id) select ${p.id},created_at,id from integrity_observations where id=${last.id} on conflict(policy_id) do update set last_created_at=excluded.last_created_at,last_id=excluded.last_id`;
    await t`update integrity_runs set scanned=${rows.length},findings=${n} where id=${run.id}`;
    return {
      runId: run.id,
      scanned: rows.length,
      findings: n,
      hasMore: rows.length === 500,
    };
  });
}
/** F-221/F-606: investigators see current scope AND current outlet owner, not merely historical scope.
 * @param {any} c */
export async function readQueue(c) {
  await requireCapability(c, "integrity.read");
  const { unitIds } = await scopeFilterForActor(c.db, c.actor);
  const ids =
    unitIds ??
    (await c.db`select id from org_units where deleted_at is null`).map(
      (/** @type {any} */ u) => u.id,
    );
  const after = c.url.searchParams.get("after"),
    limit = 50;
  if (after && !isUuid(after)) throw invalid("Invalid queue cursor");
  const rows =
    await c.db`select f.*,p.name as person_name,o.name as outlet_name,
    (select jsonb_build_object('outcome',d.outcome,'reasonCode',d.reason_code,'at',d.created_at) from integrity_dispositions d where d.finding_id=f.id order by d.created_at desc,id desc limit 1) as disposition
    from integrity_findings f join profiles p on p.id=f.profile_id left join outlets o on o.id=f.outlet_id
    where f.org_unit_id in ${c.db(ids.length ? ids : [null])} and p.org_unit_id in ${c.db(ids.length ? ids : [null])}
      and (${after}::uuid is null or (f.created_at,f.id)>(select created_at,id from integrity_findings where id=${after}::uuid)) order by f.created_at,f.id limit ${limit + 1}`;
  const visible = [];
  for (const r of rows.slice(0, limit)) {
    if (r.outlet_id) {
      const owner = await outletOwnerUnit(c.db, r.outlet_id, Date.now());
      if (!ids.includes(owner)) continue;
    }
    const [observation] =
      await c.db`select facts from integrity_observations where source_key=${r.source_key}`;
    if (observation?.facts.orderId) {
      try {
        await accessibleOrder(c, observation.facts.orderId);
      } catch {
        continue;
      }
    }
    if (observation?.facts.tripId) {
      try {
        await tripFor(c.db, c.actor, observation.facts.tripId);
      } catch {
        continue;
      }
    }
    visible.push({
      id: r.id,
      rule: r.rule,
      severity: r.severity,
      person: r.person_name,
      outlet: r.outlet_name,
      occurredAt: new Date(r.occurred_at).getTime(),
      evidence: r.evidence,
      disposition: r.disposition,
    });
  }
  const last = rows.slice(0, limit).at(-1);
  const [{ total, mock, prior_total, prior_mock }] =
    await c.db`select count(*) filter(where occurred_at>=now()-interval '7 days')::int as total,
    count(*) filter(where occurred_at>=now()-interval '7 days' and facts->>'mockSignal'='true')::int as mock,
    count(*) filter(where occurred_at<now()-interval '7 days')::int as prior_total,
    count(*) filter(where occurred_at<now()-interval '7 days' and facts->>'mockSignal'='true')::int as prior_mock
    from integrity_observations i where kind in ('check_in','refused_check_in') and occurred_at>=now()-interval '14 days' and org_unit_id in ${c.db(ids.length ? ids : [null])}
    and exists (select 1 from profiles p where p.id=i.profile_id and p.deleted_at is null and p.org_unit_id in ${c.db(ids.length ? ids : [null])})
    and (i.outlet_id is null or exists (
      select 1 from outlets o
      cross join lateral (select count(*) n,min(a.territory_id::text)::uuid territory_id from outlet_assignments a where a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())) a
      cross join lateral (select count(*) n,min(t.org_unit_id::text)::uuid org_unit_id from territory_ownerships t where t.territory_id=a.territory_id and t.deleted_at is null and t.effective_from<=now() and (t.effective_to is null or t.effective_to>now())) t
      where o.id=i.outlet_id and o.deleted_at is null and (
        (a.n=0 and o.custodian_org_unit_id in ${c.db(ids.length ? ids : [null])})
        or (a.n=1 and t.n=1 and t.org_unit_id in ${c.db(ids.length ? ids : [null])})
      )
    ))`;
  const p = await policyAt(c.db);
  return {
    items: visible,
    next: rows.length > limit && last ? last.id : null,
    mockRate: {
      attempts: total,
      incidents: mock,
      ratePct: total ? (100 * mock) / total : null,
      targetBelowPct: p.settings.mockExitRatePct,
      priorPct: prior_total ? (100 * prior_mock) / prior_total : null,
      definition:
        "Accepted or mock-refused signed check-in attempts, including uploaded on-phone refusals, received by the server in the last 7 days. Malformed requests and not-yet-uploaded attempts are excluded; OS signals are not hardware attestation.",
    },
    policySource: p.source_ref,
  };
}
