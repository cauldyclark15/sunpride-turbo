import {
  requireCapability,
  requireNationalScope,
  roleHas,
} from "../../core/capabilities.js";
import { forbidden, invalid, conflict } from "../../core/errors.js";
import { isUuid, canonicalJson, sha256Hex } from "../../core/util.js";
import { verifySignature } from "../../core/devices.js";
import { scopeFilterForActor, outletOwnerUnit } from "../org/scope.js";
import { accessibleOrder } from "../orders/access.js";
import { tripFor } from "../van/access.js";
import {
  command,
  scopedDevice,
  requestControl,
  requestHandover,
  completeHandover,
  controlContact,
  recoveryKey,
  audit,
  reason,
} from "./governance.js";
import { installOidc, installMockIdp } from "./oidc.js";
import { detect, policyAt, readQueue } from "./detectors.js";
import { collectCommercialSignals } from "./commercial.js";

/** @param {unknown} value @param {number} max @param {boolean} [trim] */
const text = (value, max, trim = true) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f]/.test(value)
  )
    throw invalid("Enter a valid value");
  return trim ? value.trim() : value;
};
/** @param {any} c */
async function units(c) {
  const { unitIds } = await scopeFilterForActor(c.db, c.actor);
  return (
    unitIds ??
    (await c.db`select id from org_units where deleted_at is null`).map(
      (/** @type {any} */ r) => r.id,
    )
  );
}
/** @param {any} c @param {any} b */
async function setFleet(c, b) {
  const tag = text(b.assetTag, 100),
    unitId = b.orgUnitId;
  if (!isUuid(unitId)) throw invalid("Choose an area");
  await requireCapability(c, "admin.manage", unitId);
  if (b.deviceId) {
    const d = await scopedDevice(c, b.deviceId);
    if (d.org_unit_id !== unitId)
      throw invalid("Phone belongs to a different area");
  }
  if (b.assignedProfileId) {
    if (!isUuid(b.assignedProfileId)) throw invalid("Choose a person");
    const [p] =
      await c.db`select * from profiles where id=${b.assignedProfileId} and status='active' and deleted_at is null`;
    if (!p || p.org_unit_id !== unitId)
      throw invalid("Choose an assigned person in this area");
    await requireCapability(c, "admin.manage", p.org_unit_id);
  }
  if (
    !["assigned", "spare", "repair", "retired"].includes(b.state) ||
    !["unknown", "enrolled", "compliant", "noncompliant", "lost"].includes(
      b.mdmStatus,
    )
  )
    throw invalid("Choose fleet and MDM states");
  if (
    !Array.isArray(b.peripherals) ||
    b.peripherals.length > 10 ||
    b.peripherals.some(
      (/** @type {any} */ p) =>
        !["printer", "scanner", "charger"].includes(p.kind) ||
        typeof p.tag !== "string" ||
        p.tag.length > 100,
    )
  )
    throw invalid("Enter up to ten printer, scanner or charger assets");
  const at = b.effectiveFrom ?? Date.now();
  if (
    !Number.isSafeInteger(at) ||
    at < Date.now() - 60_000 ||
    at > Date.now() + 366 * 86400_000
  )
    throw invalid("Choose a prospective effective time");
  await c.db`select pg_advisory_xact_lock(hashtext(${`fleet:${tag}`}))`;
  const prior =
    await c.db`select * from fleet_asset_versions where asset_tag=${tag} order by effective_from desc`;
  for (const r of prior)
    await requireCapability(c, "admin.manage", r.org_unit_id);
  if (
    prior.some(
      (/** @type {any} */ r) => new Date(r.effective_from).getTime() >= at,
    )
  )
    throw conflict("A later asset version already exists");
  await c.db`update fleet_asset_versions set effective_to=${new Date(at)} where asset_tag=${tag} and effective_to is null`;
  const [r] =
    await c.db`insert into fleet_asset_versions(asset_tag,org_unit_id,device_id,assigned_profile_id,model,state,peripherals,mdm_status,mdm_source,mdm_observed_at,data_plan,break_fix_due_at,note,effective_from,source_ref)
    values (${tag},${unitId},${b.deviceId || null},${b.assignedProfileId || null},${text(b.model, 100)},${b.state},${b.peripherals},${b.mdmStatus},${text(b.mdmSource, 150)},${b.mdmObservedAt ? new Date(b.mdmObservedAt) : null},${text(b.dataPlan, 150)},${b.breakFixDueAt ? new Date(b.breakFixDueAt) : null},${typeof b.note === "string" ? b.note.slice(0, 500) : ""},${new Date(at)},${text(b.sourceRef, 200)}) returning id`;
  await audit(c, "fleet.version_saved", r.id, {
    assetTag: tag,
    state: b.state,
    source: b.sourceRef,
  });
  return { id: r.id };
}
/** @param {any} router @param {any} platform */
export function install(router, platform) {
  installOidc(router);
  installMockIdp(router, platform);
  platform.registerTopic(
    "integrity",
    (/** @type {any} */ actor) =>
      roleHas(actor.role, "integrity.read") ||
      roleHas(actor.role, "admin.manage"),
  );
  platform.registerJob("integrity.detect", async (/** @type {any} */ c) => {
    await collectCommercialSignals(c.db);
    await detect(c.db);
    await platform.publish("integrity");
  });
  platform.scheduler.every(
    60_000,
    "integrity-detection",
    async (/** @type {any} */ c) => {
      await collectCommercialSignals(c.db);
      await detect(c.db);
      await platform.publish("integrity");
    },
  );
  router.post(
    "/api/devices/control/recover",
    (/** @type {any} */ c) => controlContact(c, verifySignature, "recover"),
    { v2: true },
  );
  router.post(
    "/api/devices/control/ack",
    (/** @type {any} */ c) => controlContact(c, verifySignature, "ack"),
    { v2: true },
  );
  router.post("/api/v1/integrity/recovery/export", (/** @type {any} */ ctx) =>
    command(ctx, async (c) => {
      if (!isUuid(c.body.controlId)) throw invalid();
      const [control] =
        await c.db`select * from device_controls where id=${c.body.controlId}`;
      if (!control) throw forbidden();
      const device = await scopedDevice(c, control.device_id);
      const [person] =
        await c.db`select org_unit_id from profiles where id=${device.profile_id}`;
      if (!person?.org_unit_id)
        throw forbidden(
          "Reconcile the person's current assignment before exporting recovery",
        );
      await requireCapability(c, "admin.manage", person.org_unit_id);
      const [bundle] =
        await c.db`select * from device_recovery_bundles where control_id=${control.id}`;
      if (!bundle)
        throw conflict("The phone has not uploaded recovery work yet");
      const bytes = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Buffer.from(bundle.nonce, "base64"),
          additionalData: new TextEncoder().encode(control.id),
        },
        await recoveryKey(c.env),
        Buffer.from(bundle.ciphertext, "base64"),
      );
      await audit(c, "device.recovery_exported", device.id, {
        reason: reason(c.body.reasonCode),
        queuedCount: bundle.queued_count,
      });
      return {
        warning:
          "Held evidence for supervised reconciliation only. Do not recapture or replay automatically.",
        queuedCount: bundle.queued_count,
        bundleJson: new TextDecoder().decode(bytes),
        bundle: JSON.parse(new TextDecoder().decode(bytes)),
      };
    }),
  );
  router.get("/api/v1/integrity/queue", readQueue);
  // F-606: the analytics owner composes this canonical queue at /analytics/fraud.
  router.post("/api/v1/integrity/run", async (/** @type {any} */ c) => {
    await requireNationalScope(c, ["admin"]);
    await requireCapability(c, "integrity.review");
    return {
      ...(await collectCommercialSignals(c.db)),
      ...(await detect(c.db)),
    };
  });
  router.post("/api/v1/integrity/dispose", (/** @type {any} */ ctx) =>
    command(ctx, async (c) => {
      if (!isUuid(c.body.findingId)) throw invalid();
      const [f] =
        await c.db`select * from integrity_findings where id=${c.body.findingId}`;
      if (!f) throw forbidden();
      await requireCapability(c, "integrity.review", f.org_unit_id);
      if (f.profile_id === c.actor.profileId)
        throw forbidden("A different person must review this finding");
      const [person] =
        await c.db`select org_unit_id from profiles where id=${f.profile_id}`;
      await requireCapability(c, "integrity.review", person?.org_unit_id);
      if (f.outlet_id)
        await requireCapability(
          c,
          "integrity.review",
          await outletOwnerUnit(c.db, f.outlet_id, Date.now()),
        );
      const [obs] =
        await c.db`select facts from integrity_observations where source_key=${f.source_key}`;
      if (obs?.facts.orderId) await accessibleOrder(c, obs.facts.orderId);
      if (obs?.facts.tripId) await tripFor(c.db, c.actor, obs.facts.tripId);
      if (
        !["confirmed", "false_positive", "needs_evidence"].includes(
          c.body.outcome,
        )
      )
        throw invalid("Choose a review outcome");
      const key = c.req.headers.get("idempotency-key");
      const hash = sha256Hex(canonicalJson(c.body));
      if (key) {
        if (key.length > 200) throw invalid("Invalid request key");
        await c.db`select pg_advisory_xact_lock(hashtext(${`integrity-command:${c.actor.userId}:${key}`}))`;
        const [prior] =
          await c.db`select * from integrity_command_receipts where user_id=${c.actor.userId} and request_key=${key}`;
        if (prior) {
          if (prior.request_hash !== hash)
            throw conflict("This request key has different review facts");
          return prior.response;
        }
      }
      const [r] =
        await c.db`insert into integrity_dispositions(finding_id,decided_by,outcome,reason_code) values (${f.id},${c.actor.userId},${c.body.outcome},${reason(c.body.reasonCode)}) returning id`;
      await audit(c, "integrity.finding_reviewed", f.id, {
        outcome: c.body.outcome,
        reason: c.body.reasonCode,
      });
      const response = { id: r.id, outcome: c.body.outcome };
      if (key)
        await c.db`insert into integrity_command_receipts(user_id,request_key,request_hash,response) values (${c.actor.userId},${key},${hash},${response})`;
      return response;
    }),
  );
  router.get("/api/v1/integrity/policy", async (/** @type {any} */ c) => {
    await requireCapability(c, "integrity.read");
    return policyAt(c.db);
  });
  router.post("/api/v1/integrity/policy", (/** @type {any} */ ctx) =>
    command(ctx, async (c) => {
      await requireNationalScope(c, ["admin"]);
      await requireCapability(c, "admin.manage");
      const current = await policyAt(c.db),
        b = c.body,
        at = b.effectiveFrom;
      const keys = Object.keys(current.settings);
      if (
        !Number.isSafeInteger(at) ||
        at < Date.now() ||
        at > Date.now() + 366 * 86400_000 ||
        !b.settings ||
        Object.keys(b.settings).sort().join() !== keys.sort().join() ||
        keys.some(
          (k) =>
            !Number.isFinite(b.settings[k]) ||
            b.settings[k] < 0 ||
            b.settings[k] > 1e9,
        )
      )
        throw invalid("Supply all policy limits and a prospective time");
      if (b.settings.mockExitRatePct !== 0.5)
        throw invalid("The spec exit criterion remains below 0.5%");
      await c.db`select pg_advisory_xact_lock(hashtext('integrity-policy'))`;
      const later =
        await c.db`select 1 from integrity_policy_versions where code='field-integrity' and effective_from>=${new Date(at)}`;
      if (later.length) throw conflict("A later policy is already scheduled");
      await c.db`update integrity_policy_versions set effective_to=${new Date(at)} where code='field-integrity' and effective_to is null`;
      const [p] =
        await c.db`insert into integrity_policy_versions(code,settings,effective_from,source_ref) values ('field-integrity',${b.settings},${new Date(at)},${text(b.sourceRef, 200)}) returning id`;
      await audit(c, "integrity.policy_scheduled", p.id, {
        source: b.sourceRef,
      });
      return { id: p.id };
    }),
  );
  router.get("/api/v1/integrity/fleet", async (/** @type {any} */ c) => {
    await requireCapability(c, "admin.manage");
    const ids = await units(c);
    const assets =
      await c.db`select f.*,case when p.deleted_at is null and p.status='active' and p.org_unit_id in ${c.db(ids.length ? ids : [null])} then p.name else null end as assigned_name,
      (f.assigned_profile_id is not null and (p.id is null or p.org_unit_id is null or p.deleted_at is not null or p.status<>'active' or p.org_unit_id not in ${c.db(ids.length ? ids : [null])})) as assignment_needs_review
      from fleet_asset_versions f left join profiles p on p.id=f.assigned_profile_id where f.org_unit_id in ${c.db(ids.length ? ids : [null])} and f.effective_from<=now() and (f.effective_to is null or f.effective_to>now()) order by f.asset_tag limit 501`;
    const devices =
      await c.db`select d.id,d.inventory_tag as label,d.app,d.status,d.profile_id,p.name as person,d.org_unit_id,d.last_seen_at,
      (select row_to_json(c) from device_controls c where c.device_id=d.id order by c.created_at desc limit 1) as control,
      (select h.id from device_handovers h where h.from_device_id=d.id and status='reconciling' limit 1) as handover_id,
      (select jsonb_build_object('source',a.source,'rooted',a.rooted,'tampered',a.tampered,'observedAt',a.observed_at,'expiresAt',a.expires_at) from (select distinct on(source) * from device_integrity_assessments where device_id=d.id order by source,observed_at desc,id desc) a order by (a.rooted or a.tampered) desc,a.observed_at desc limit 1) as assessment
      from registered_devices d join profiles p on p.id=d.profile_id where d.org_unit_id in ${c.db(ids.length ? ids : [null])} and p.org_unit_id in ${c.db(ids.length ? ids : [null])} order by d.created_at desc limit 501`;
    return {
      assets: assets.slice(0, 500),
      devices: devices.slice(0, 500),
      truncated: assets.length > 500 || devices.length > 500,
      units:
        await c.db`select id,name from org_units where id in ${c.db(ids.length ? ids : [null])} and deleted_at is null`,
      people:
        await c.db`select id,name,org_unit_id from profiles where org_unit_id in ${c.db(ids.length ? ids : [null])} and deleted_at is null and status='active' order by name limit 501`,
      providers:
        c.actor.role === "super_admin"
          ? await c.db`select code,label,issuer,client_id,redirect_uri,source_ref from identity_providers where effective_from<=now() and (effective_to is null or effective_to>now())`
          : [],
    };
  });
  router.post("/api/v1/integrity/fleet/save", (/** @type {any} */ c) =>
    command(c, (local) => setFleet(local, local.body)),
  );
  router.post("/api/v1/integrity/fleet/import-mdm", (/** @type {any} */ c) =>
    command(c, async (local) => {
      await requireCapability(local, "admin.manage");
      if (
        !Array.isArray(local.body.rows) ||
        !local.body.rows.length ||
        local.body.rows.length > 200
      )
        throw invalid("Import up to 200 assets");
      const result = [];
      for (const b of local.body.rows) result.push(await setFleet(local, b));
      return { imported: result.length };
    }),
  );
  router.post("/api/v1/integrity/devices/wipe", (/** @type {any} */ c) =>
    command(c, async (local) => {
      const d = await scopedDevice(local, local.body.deviceId);
      const r = await requestControl(
        local,
        d,
        "wipe",
        reason(local.body.reasonCode),
      );
      return { controlId: r.id, status: r.status };
    }),
  );
  router.post("/api/v1/integrity/devices/handover", (/** @type {any} */ c) =>
    command(c, requestHandover),
  );
  router.post(
    "/api/v1/integrity/devices/complete-handover",
    (/** @type {any} */ c) => command(c, completeHandover),
  );
  router.post("/api/v1/integrity/devices/assessment", (/** @type {any} */ c) =>
    command(c, async (local) => {
      const d = await scopedDevice(local, local.body.deviceId),
        b = local.body;
      if (typeof b.rooted !== "boolean" || typeof b.tampered !== "boolean")
        throw invalid();
      if (d.profile_id === local.actor.profileId)
        throw forbidden("A different administrator must review this phone");
      if (text(b.source, 150) === "android-self-report")
        throw invalid(
          "Native self-report provenance is reserved for the phone",
        );
      const [a] =
        await local.db`insert into device_integrity_assessments(device_id,rooted,tampered,source,observed_at,expires_at,evidence)
      values (${d.id},${b.rooted},${b.tampered},${text(b.source, 150)},now(),now()+interval '1 day',${{ verified: false, importedBy: local.actor.userId }}) returning id`;
      await audit(local, "device.integrity_assessed", d.id, {
        assessmentId: a.id,
        source: b.source,
      });
      return { id: a.id };
    }),
  );
  router.post("/api/v1/integrity/devices/exception", (/** @type {any} */ c) =>
    command(c, async (local) => {
      const d = await scopedDevice(local, local.body.deviceId),
        b = local.body;
      if (d.profile_id === local.actor.profileId)
        throw forbidden("A different administrator must approve the exception");
      if (
        !Number.isSafeInteger(b.expiresAt) ||
        b.expiresAt <= Date.now() ||
        b.expiresAt > Date.now() + 86400_000
      )
        throw invalid("Exceptions expire within one day");
      const [a] =
        await local.db`insert into device_integrity_exceptions(device_id,approved_by,reason_code,effective_from,effective_to)
      values (${d.id},${local.actor.userId},${reason(b.reasonCode)},now(),${new Date(b.expiresAt)}) returning id`;
      await audit(local, "device.integrity_exception", d.id, {
        exceptionId: a.id,
        reason: b.reasonCode,
      });
      return { id: a.id };
    }),
  );
  router.post("/api/v1/integrity/identity/provider", (/** @type {any} */ c) =>
    command(c, async (local) => {
      await requireNationalScope(local, ["admin"]);
      await requireCapability(local, "admin.manage");
      // F-007: changing SSO trust can impersonate any linked role; ordinary admins cannot rewrite it.
      if (local.actor.role !== "super_admin")
        throw forbidden(
          "Only the super administrator can configure company sign-in",
        );
      const b = local.body;
      const issuerValue = text(b.issuer, 500, false),
        redirectValue = text(b.redirectUri, 500, false);
      if (/\s/.test(issuerValue) || /\s/.test(redirectValue))
        throw invalid("Enter exact OIDC URLs without whitespace");
      let issuer, redirect;
      try {
        issuer = new URL(issuerValue);
        redirect = new URL(redirectValue);
      } catch {
        throw invalid("Enter valid OIDC URLs");
      }

      const mock =
        local.env.SP_MOCK_IDP === "1" &&
        issuer.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(issuer.hostname);
      if (
        (issuer.protocol !== "https:" && !mock) ||
        issuer.username ||
        issuer.password ||
        issuer.hash ||
        issuer.search ||
        redirect.username ||
        redirect.password ||
        redirect.hash ||
        redirect.search ||
        redirect.pathname !== "/api/auth/oidc/callback" ||
        (redirect.origin !== issuer.origin &&
          redirect.protocol !== "https:" &&
          !(
            mock &&
            redirect.protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(redirect.hostname)
          ))
      )
        throw invalid("Use secure OIDC endpoints");
      const at = b.effectiveFrom ?? Date.now();
      if (!Number.isSafeInteger(at) || at < Date.now() - 60_000)
        throw invalid();
      const code = reason(b.code);
      await local.db`select pg_advisory_xact_lock(hashtext(${`identity-provider:${code}`}))`;
      if (
        (
          await local.db`select 1 from identity_providers where code=${code} and effective_from>=${new Date(at)}`
        ).length
      )
        throw conflict("A later provider version exists");
      await local.db`update identity_providers set effective_to=${new Date(at)} where code=${code} and effective_to is null`;
      const [p] =
        await local.db`insert into identity_providers(code,label,issuer,client_id,redirect_uri,effective_from,source_ref)
      values (${code},${text(b.label, 100)},${issuerValue},${text(b.clientId, 200, false)},${redirectValue},${new Date(at)},${text(b.sourceRef, 200)}) returning id`;
      await audit(local, "identity.provider_saved", p.id, { code });
      return { id: p.id };
    }),
  );
  router.post("/api/v1/integrity/identity/link", (/** @type {any} */ c) =>
    command(c, async (local) => {
      await requireNationalScope(local, ["admin"]);
      await requireCapability(local, "admin.manage");
      // F-007: changing SSO trust can impersonate any linked role; ordinary admins cannot rewrite it.
      if (local.actor.role !== "super_admin")
        throw forbidden(
          "Only the super administrator can configure company sign-in",
        );
      if (!isUuid(local.body.profileId)) throw invalid();
      const [p] =
        await local.db`select * from profiles where id=${local.body.profileId} and status='active' and deleted_at is null`;
      if (!p?.user_id) throw invalid("Choose a person with a login");
      await requireCapability(local, "admin.manage", p.org_unit_id);
      const [f] =
        await local.db`insert into federated_identities(issuer,subject,user_id) values (${text(local.body.issuer, 500, false)},${text(local.body.subject, 512, false)},${p.user_id}) returning id`;
      await audit(local, "identity.linked", f.id, { profileId: p.id });
      return { id: f.id };
    }),
  );
}
