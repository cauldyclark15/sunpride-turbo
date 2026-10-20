import {
  ownedVisit,
  product,
  validTime,
  manilaDate,
  touchVisit,
  event,
  changed as visitChanged,
} from "../visits/shared.js";
import { advance, ownedCall } from "../callflow/engine.js";
import {
  accessOutlet,
  bounded,
  changed,
  canonicalJson,
  sha256Hex,
  choice,
  date,
  integer,
  invalid,
  once,
  officePerson,
  photos,
  seams,
  text,
  uuid,
} from "./common.js";
import { currentMasters, masterById, policyAt } from "./masters.js";
/** @param {any} m @param {number} at */
function effective(m, at) {
  if (
    !m ||
    +new Date(m.effective_from) > at ||
    (m.effective_to && +new Date(m.effective_to) <= at)
  )
    throw invalid("Refresh the retail policy before capturing");
  return m;
}
/** @param {any} value */
function bool(value) {
  if (typeof value !== "boolean") throw invalid("Answer each checklist item");
  return value;
}
/** @param {any} c @param {any} visit @param {string} kind @param {any} d @param {number} at */
async function validate(c, visit, kind, d, at) {
  const { outlet } = await accessOutlet(c, visit.outlet_id, "visit.record");
  let master = null,
    score = null;
  /** @type {any} */ let facts = {};
  if (kind === "planogram") {
    master = effective(
      await masterById(c.db, uuid(d.masterVersionId), "planogram"),
      at,
    );
    const expected = await policyAt(c.db, "planogram", outlet, at);
    if (expected?.id !== master.id) throw invalid("Wrong class planogram");
    if (
      !Array.isArray(d.lines) ||
      d.lines.length !== master.data.lines.length ||
      new Set(d.lines.map((/** @type {any} */ l) => l.productId)).size !==
        d.lines.length
    )
      throw invalid("Count every target product");
    const lines = master.data.lines.map((/** @type {any} */ target) => {
      const actual = d.lines.find(
        (/** @type {any} */ l) => l.productId === target.productId,
      );
      if (!actual) throw invalid("Missing target product");
      return {
        productId: target.productId,
        targetFacings: target.facings,
        targetPosition: target.position,
        facings: integer(actual.facings, 10000),
        position: text(actual.position, 100),
      };
    });
    const own = integer(d.ownFacings, 1_000_000),
      total = integer(d.totalFacings, 1_000_000, 1);
    if (
      own > total ||
      lines.reduce(
        (/** @type {number} */ n, /** @type {any} */ l) => n + l.facings,
        0,
      ) !== own
    )
      throw invalid(
        "Own facings must match counted target products and total shelf",
      );
    const share = (100 * own) / total;
    const facingScore =
      (lines.reduce(
        (/** @type {number} */ n, /** @type {any} */ l) =>
          n +
          Math.min(l.facings / l.targetFacings, 1) *
            (l.position === l.targetPosition ? 1 : 0),
        0,
      ) /
        lines.length) *
      100;
    score = Math.min(
      facingScore,
      master.data.targetSharePercent
        ? (share / master.data.targetSharePercent) * 100
        : 100,
      100,
    );
    facts = {
      lines,
      ownFacings: own,
      totalFacings: total,
      sharePercent: share,
      target: master.data,
    };
  } else if (kind === "freezer") {
    master = effective(
      await masterById(c.db, uuid(d.equipmentVersionId), "equipment"),
      at,
    );
    if (
      master.data.outletId !== visit.outlet_id ||
      d.scannedSerial !== master.data.serial
    )
      throw invalid("Scan this store's registered equipment serial");
    // The asset agreement pins its policy version. Publishing a new policy cannot rewrite an existing agreement.
    const policy = await masterById(
      c.db,
      master.data.policyVersionId,
      "cold_policy",
    );
    if (!policy) throw invalid("Equipment agreement policy is unavailable");
    const temperature = integer(d.temperatureDeciC, 600, -600),
      own = integer(d.ownSharePercent, 100),
      measured = integer(d.measuredAt, Number.MAX_SAFE_INTEGER, 1);
    if (measured > at || at - measured > 60 * 60 * 1000)
      throw invalid("Record a fresh temperature measurement");
    const breaches = [];
    if (own < policy.data.minOwnSharePercent) breaches.push("purity");
    if (
      temperature < policy.data.minTemperatureDeciC ||
      temperature > policy.data.maxTemperatureDeciC
    )
      breaches.push("temperature");
    score = breaches.length ? 0 : 100;
    facts = {
      equipment: master.data,
      policyVersionId: policy.id,
      policy: policy.data,
      scannedSerial: d.scannedSerial,
      temperatureDeciC: temperature,
      ownSharePercent: own,
      measuredAt: measured,
      breaches,
    };
  } else if (kind === "posm") {
    const unit = text(d.unitCode, 100);
    await c.db`select pg_advisory_xact_lock(hashtextextended(${`posm:${unit}`},0))`;
    const [deployed] =
      await c.db`select * from posm_custody_events where unit_code=${unit} order by occurred_at desc,id desc limit 1`;
    const deploying = d.action === "deploy";
    if (
      !deployed ||
      +new Date(deployed.occurred_at) > at ||
      (deploying
        ? deployed.kind !== "issue" ||
          deployed.custodian_profile_id !== c.actor.profileId
        : deployed.kind !== "deploy" || deployed.outlet_id !== visit.outlet_id)
    )
      throw invalid("Choose POSM issued to you, or deployed at this outlet");
    master = await masterById(c.db, deployed.material_version_id, "posm");
    const present = bool(d.present),
      condition = choice(d.condition, ["good", "damaged", "missing"]);
    if (present === (condition === "missing") || (deploying && !present))
      throw invalid("Presence and condition disagree");
    score = present && condition === "good" ? 100 : 0;
    facts = {
      unitCode: unit,
      present,
      condition,
      deploymentId: deployed.id,
      deploying,
    };
  } else if (kind === "promotion") {
    const campaigns = await seams.campaigns(c, outlet, at),
      campaign = campaigns?.find(
        (/** @type {any} */ x) => x.id === d.campaignVersionId,
      );
    if (!campaign)
      throw invalid("Campaign is not active and assigned to this store");
    const checks = Object.fromEntries(
      ["display", "price", "posm", "stock"].map((k) => [k, bool(d[k])]),
    );
    if (
      !Array.isArray(d.checklist) ||
      d.checklist.length !== campaign.checklist.length ||
      d.checklist.some(
        (/** @type {any} */ x, /** @type {number} */ i) =>
          x.label !== campaign.checklist[i] || typeof x.passed !== "boolean",
      )
    )
      throw invalid("Answer the published campaign checklist");
    const results = [
      ...Object.values(checks),
      ...d.checklist.map((/** @type {any} */ x) => x.passed),
    ];
    score = (100 * results.filter(Boolean).length) / results.length;
    facts = {
      campaignId: campaign.campaign_id,
      campaignVersionId: campaign.id,
      campaignName: campaign.name,
      checks,
      checklist: d.checklist,
    };
  } else if (kind === "expiry") {
    if (!Array.isArray(d.lines) || !d.lines.length || d.lines.length > 200)
      throw invalid("Enter shelf batches");
    const policies = await currentMasters(c.db, "expiry_policy", at),
      seen = new Set();
    const lines = [];
    for (const l of d.lines) {
      const p = await product(c.db, l.productId),
        batch = text(l.batch, 100),
        expires = date(l.expiryDate),
        quantity = integer(l.quantityBase, 1_000_000_000, 1);
      const key = `${p.id}|${batch}|${expires}`;
      if (seen.has(key)) throw invalid("Combine duplicate shelf batches");
      seen.add(key);
      const match = policies.filter(
        (/** @type {any} */ x) => x.data.productId === p.id,
      );
      if (match.length !== 1)
        throw invalid("Set one near-expiry policy for this product");
      const days = Math.round(
          (Date.parse(expires) - Date.parse(manilaDate(at))) / 86400000,
        ),
        policy = match[0];
      lines.push({
        productId: p.id,
        productName: p.name,
        batch,
        expiryDate: expires,
        quantityBase: quantity,
        daysRemaining: days,
        atRisk: days <= policy.data.nearExpiryDays,
        action: days < 0 ? "pullout" : policy.data.action,
        policyVersionId: policy.id,
        thresholdDays: policy.data.nearExpiryDays,
      });
    }
    facts = { lines };
  } else if (kind === "competitor") {
    if (d.noneObserved === true) facts = { noneObserved: true };
    else {
      const type = choice(d.type, [
        "price",
        "promotion",
        "new_sku",
        "display",
        "shelf_share",
      ]);
      facts = {
        type,
        brand: text(d.brand, 100),
        sku: text(d.sku, 200),
        note: text(d.note, 1000),
      };
      if (type === "price") {
        facts.priceCentavos = integer(d.priceCentavos);
        facts.currency = "PHP";
      }
      if (type === "shelf_share")
        facts.sharePercent = integer(d.sharePercent, 100);
      if (type === "promotion" || type === "display")
        facts.description = text(d.description, 500);
    }
  } else if (kind === "issue_log") {
    if (d.noneObserved === true) facts = { noneObserved: true };
    else {
      master = effective(
        await masterById(c.db, uuid(d.categoryVersionId), "incident_category"),
        at,
      );
      const geo = d.geo;
      if (
        !geo ||
        !Number.isFinite(geo.latitude) ||
        Math.abs(geo.latitude) > 90 ||
        !Number.isFinite(geo.longitude) ||
        Math.abs(geo.longitude) > 180 ||
        !Number.isFinite(geo.accuracyMeters) ||
        geo.accuracyMeters < 0 ||
        geo.accuracyMeters > 1000 ||
        !Number.isSafeInteger(geo.fixTime) ||
        Math.abs(at - geo.fixTime) > 60000
      )
        throw invalid("Capture an accurate incident location");
      facts = {
        category: master.label,
        severity: master.data.severity,
        note: text(d.note, 1000),
        geo,
      };
    }
  } else throw invalid("Unsupported retail form");
  const required =
    ["freezer", "posm", "promotion", "expiry", "planogram"].includes(kind) ||
    (["competitor", "issue_log"].includes(kind) && !facts.noneObserved);
  facts.evidenceIds = await photos(c, visit, d.evidenceIds ?? [], required);
  return { master, score, facts };
}
/** F-310 F-311 F-313 F-315 F-317 F-318 F-320 F-321: shared signed outbox writer; never client-supplied scores.
 * @param {any} c */
export async function capture(c) {
  const b = c.payload ?? c.body,
    visit = await ownedVisit(c, b.visitId, true);
  validTime(b.deviceTime, c.now);
  if (+new Date(visit.started_at ?? visit.checked_in_at) > b.deviceTime)
    throw invalid("Observation precedes check-in");
  const result = await once(c, "capture", b, async () => {
    if (!["checked-in", "in-progress"].includes(visit.state))
      throw invalid("The call is closed");
    const kind = choice(b.kind, [
      "planogram",
      "posm",
      "freezer",
      "competitor",
      "promotion",
      "expiry",
      "issue_log",
    ]);
    const { master, score, facts } = await validate(
      c,
      visit,
      kind,
      b.data,
      b.deviceTime,
    );
    const [n] =
      await c.db`select count(*)::int as n from retail_execution_audits where visit_id=${visit.id}`;
    if (n.n >= 500) throw invalid("Call observation limit reached");
    if (kind === "posm" && facts.deploying) {
      const [deployment] =
        await c.db`insert into posm_custody_events(material_version_id,unit_code,kind,outlet_id,custodian_profile_id,photo_id,reason,request_key,actor_subject,occurred_at)
        values(${master.id},${facts.unitCode},'deploy',${visit.outlet_id},${c.actor.profileId},${facts.evidenceIds[0]},'Deployed during outlet call',${b.requestKey},${c.actor.subject},${new Date(b.deviceTime)}) returning id`;
      facts.deploymentId = deployment.id;
    }
    const [row] =
      await c.db`insert into retail_execution_audits(visit_id,outlet_id,profile_id,org_unit_id,kind,request_key,payload_hash,master_version_id,facts,component_score,captured_at,actor_subject) values(${visit.id},${visit.outlet_id},${c.actor.profileId},${visit.org_unit_id},${kind},${b.requestKey},${sha256Hex(canonicalJson(b))},${master?.id ?? null},${facts},${score},${new Date(b.deviceTime)},${c.actor.subject}) returning id`;
    const call = await ownedCall(c, { visitId: visit.id });
    if (
      call?.definition_snapshot.steps.some(
        (/** @type {any} */ s) => s.adapter === kind,
      )
    )
      await advance(c, call, kind, row.id);
    if (kind === "freezer" && facts.breaches.length)
      await createCase(
        c,
        row.id,
        visit,
        "cold_breach",
        facts,
        master ? facts.policy.followupHours : 24,
      );
    if (kind === "expiry")
      for (const line of facts.lines)
        if (line.atRisk)
          await createCase(c, row.id, visit, line.action, line, 24);
    if (kind === "issue_log" && !facts.noneObserved)
      await createCase(
        c,
        row.id,
        visit,
        "incident",
        facts,
        master.data.slaHours,
      );
    await c.db`update visit_executions set state='in-progress' where id=${visit.id}`;
    await touchVisit(c, visit);
    const eventId = await event(
      c,
      visit,
      "visit",
      visit.id,
      `retail.${kind}.captured`,
    );
    await changed(c, `${kind}.captured`, row.id);
    await visitChanged(c, visit);
    return { entityId: row.id, eventIds: [eventId] };
  });
  return result;
}
/** @param {any} c @param {string} auditId @param {any} visit @param {string} kind @param {any} facts @param {number} hours */
async function createCase(c, auditId, visit, kind, facts, hours) {
  await c.db`insert into retail_action_cases(audit_id,outlet_id,kind,due_at,facts) values(${auditId},${visit.outlet_id},${kind},${new Date(c.now + hours * 3600000)},${facts})`;
}
/** F-313: one individually identifiable POSM lifecycle, serialized across office and phone.
 * @param {any} c */
export async function custody(c) {
  const b = c.body,
    unit = text(b.unitCode, 100),
    kind = choice(b.kind, [
      "issue",
      "deploy",
      "return",
      "write_off_request",
      "write_off",
    ]);
  const material = await masterById(c.db, uuid(b.materialVersionId), "posm");
  if (!material) throw invalid();
  if (kind === "issue") effective(material, c.now);
  await c.db`select pg_advisory_xact_lock(hashtextextended(${`posm:${unit}`},0))`;
  const [last] =
    await c.db`select * from posm_custody_events where unit_code=${unit} order by occurred_at desc,id desc limit 1`;
  let outletId = b.outletId ? uuid(b.outletId) : null;
  if (outletId) await accessOutlet(c, outletId, "outlet.manage");
  if (last?.outlet_id) await accessOutlet(c, last.outlet_id, "outlet.manage");
  if (last?.custodian_profile_id)
    await officePerson(c, last.custodian_profile_id, true);
  const transitions = /** @type {Record<string,string[]>} */ ({
    issue: ["return"],
    deploy: ["issue"],
    return: ["deploy", "issue"],
    write_off_request: ["issue", "deploy", "return"],
    write_off: ["write_off_request"],
  });
  const oldMaterial = last
    ? await masterById(c.db, last.material_version_id, "posm")
    : null;
  if (
    (!last && kind !== "issue") ||
    (last && !transitions[kind].includes(last.kind)) ||
    (kind === "deploy" && !outletId) ||
    (last &&
      last.material_version_id !== material.id &&
      !(kind === "issue" && oldMaterial?.code === material.code))
  )
    throw invalid("Invalid POSM custody transition");
  const custodian = uuid(b.custodianProfileId);
  await officePerson(c, custodian);
  let photoId = null;
  if (kind === "deploy") {
    const [v] =
      await c.db`select * from visit_executions where id=${uuid(b.visitId)}`;
    if (!v || v.outlet_id !== outletId) throw invalid();
    photoId = (
      await photos(
        { ...c, actor: { ...c.actor, profileId: v.assignee_profile_id } },
        v,
        [b.photoId],
        true,
      )
    )[0];
  }
  if (kind === "write_off" && last.actor_subject === c.actor.subject)
    throw invalid("A different approver must write off the POSM");
  const [r] =
    await c.db`insert into posm_custody_events(material_version_id,unit_code,kind,outlet_id,custodian_profile_id,photo_id,reason,request_key,actor_subject,occurred_at) values(${material.id},${unit},${kind},${outletId ?? last?.outlet_id ?? null},${custodian},${photoId},${text(b.reason, 500)},${uuid(b.requestKey)},${c.actor.subject},${new Date(c.now)}) returning id`;
  await changed(c, "posm.custody", r.id);
  return { id: r.id };
}
/** @param {any} c */
export async function caseAction(c) {
  const b = c.body,
    [row] =
      await c.db`select r.*,a.profile_id from retail_action_cases r join retail_execution_audits a on a.id=r.audit_id where r.id=${uuid(b.caseId)} for update of r`;
  if (!row) throw invalid();
  await accessOutlet(c, row.outlet_id, "outlet.manage");
  const action = choice(b.action, ["assign", "approve", "resolve", "reject"]);
  if (["resolved", "rejected"].includes(row.status))
    throw invalid("Case is already closed");
  let status = row.status,
    owner = row.owner_profile_id;
  if (action === "assign") {
    const p = await officePerson(c, uuid(b.ownerProfileId));
    owner = p.id;
    status = "assigned";
  } else if (action === "approve") {
    if (row.profile_id === c.actor.profileId)
      throw invalid("A different person must approve the request");
    if (!["pullout", "markdown"].includes(row.kind)) throw invalid();
    const handoff = await seams.requestSapAction(c, {
      caseId: row.id,
      kind: row.kind,
      facts: row.facts,
    });
    if (handoff.status !== "acknowledged") status = "awaiting_sap";
    else status = "approved";
  } else if (action === "resolve") {
    if (["pullout", "markdown"].includes(row.kind) && row.status !== "approved")
      throw invalid("Wait for the acknowledged return or markdown instruction");
    text(b.reference);
    status = "resolved";
  } else {
    if (row.profile_id === c.actor.profileId)
      throw invalid("A different person must reject the request");
    status = "rejected";
  }
  await c.db`insert into retail_case_events(case_id,kind,note,reference,actor_subject) values(${row.id},${action},${text(b.note, 1000)},${b.reference ? text(b.reference) : null},${c.actor.subject})`;
  await c.db`update retail_action_cases set status=${status},owner_profile_id=${owner},updated_at=now() where id=${row.id}`;
  await changed(c, "case.updated", row.id);
  return { id: row.id, status };
}
