import { canonicalJson, sha256Hex, HEX64_RE } from "../../core/util.js";
import { seams } from "./seams.js";
import { changed, command, office, bounded } from "./common.js";
import { posting } from "./finance.js";
import {
  provenClaimValue,
  comparableEvidence,
  claimQuantity,
} from "./claim-matching.js";
import {
  applyExecutionOverride,
  approveExecutionOverride,
  executionExceptionEligible,
} from "./claim-overrides.js";
import { claimSourceOptions } from "./claim-source-options.js";
import { executionEvidenceAccess } from "./evidence-access.js";
import { filesDir, MAX_MEDIA_BYTES } from "../../core/media.js";
import { join } from "node:path";
import { queueClaimMail } from "./notifications.js";
import {
  choice,
  date,
  fail,
  instant,
  integer,
  manilaDate,
  text,
  uuid,
} from "../orders/validation.js";

const PARTY_TYPES = ["distributor", "modern_trade", "agency"];
const EVIDENCE_KINDS = [
  "photo",
  "checklist",
  "posm",
  "secondary_sale",
  "source_document",
  "attendance",
];
/** F-506 actual source readers; external kinds remain fail-closed until their owner is connected.
 * @param {any} c @param {string} kind @param {string} id */
export async function readEvidence(c, kind, id) {
  if (kind === "photo") {
    const [r] =
      await c.db`select e.*,f.sha256,f.status as file_status from field_evidence_files e join files f on f.id=e.storage_id where e.id=${id} and e.organization_id='sunpride' and e.deleted_at is null`;
    if (
      !r ||
      r.file_status !== "stored" ||
      r.sha256 !== r.checksum ||
      r.status === "rejected"
    )
      return null;
    const scope = await executionEvidenceAccess(c, {
      outletId: r.outlet_id,
      occurredAt: +new Date(r.captured_at),
    });
    if (!scope) return null;
    return {
      kind,
      sourceId: id,
      ...scope,
      storageId: r.storage_id,
      evidenceVersion: 2,
      outletId: r.outlet_id,
      occurredAt: new Date(r.captured_at).getTime(),
      fingerprint: `photo:${r.checksum}`,
      verified: true,
    };
  }
  if (kind === "checklist") {
    const [r] =
      await c.db`select e.*,a.device_time as execution_at,v.id as campaign_version_id from merchandising_compliance_checks e join merchandising_audits a on a.id=e.audit_id and a.deleted_at is null join campaigns m on m.code=e.program_ref and m.organization_id=e.organization_id join campaign_versions v on v.campaign_id=m.id and v.effective_from<=a.device_time and v.effective_to>a.device_time where e.id=${id} and e.organization_id='sunpride' and e.deleted_at is null and e.finding='compliant' and e.kind='promotion'`;
    if (!r) return seams.readEvidence(c, kind, id);
    const scope = await executionEvidenceAccess(c, {
      outletId: r.outlet_id,
      occurredAt: +new Date(r.execution_at),
    });
    if (!scope) return null;
    return {
      kind,
      sourceId: id,
      ...scope,
      outletId: r.outlet_id,
      campaignVersionId: r.campaign_version_id,
      occurredAt: new Date(r.execution_at).getTime(),
      fingerprint: `checklist:${id}`,
      verified: true,
    };
  }
  return seams.readEvidence(c, kind, id);
}
/** @param {any} c @param {string} id @param {boolean} [lock] */
async function claim(c, id, lock = false) {
  const rows = lock
    ? await c.db`select * from claims where id=${uuid(id)} for update`
    : await c.db`select * from claims where id=${uuid(id)}`;
  if (!rows[0]) fail("Claim not found");
  return rows[0];
}
/** @param {any} c @param {any} r @param {string} action @param {any} [details] */
async function event(c, r, action, details = {}) {
  await c.db`insert into claim_events(claim_id,action,actor_subject,details) values(${r.id},${action},${c.actor.subject},${details})`;
  const [notice] =
    await c.db`insert into claim_notifications(claim_id,party_type,party_id,message) values(${r.id},${r.claimant_party_type},${r.claimant_party_id},${`Your claim is ${action.replaceAll("_", " ")}.`}) returning id`;
  await queueClaimMail(c.db, notice.id);
  await changed(c, `claim.${action}`, r.id, details);
}
/** F-505 shared intake seam; caller identity checked here, including portal adapters.
 * @param {any} c @param {any} b */
export async function submitClaim(c, b, sourceId = crypto.randomUUID()) {
  const type = choice(b.partyType, PARTY_TYPES, "Claimant type"),
    party = text(b.partyId, "Claimant party", 160);
  await seams.authorizeClaimant(c, type, party);
  const [named] =
    type === "modern_trade"
      ? await c.db`select label as name from mt_account_bindings where id::text=${party}`
      : await c.db`select name from distributors where id::text=${party} and partner_kind=${type}`;
  const name = text(named?.name ?? b.partyName, "Claimant name", 160);
  const from = date(b.periodFrom),
    to = date(b.periodTo),
    amount = integer(b.amountCentavos);
  if (
    !amount ||
    to < from ||
    Date.parse(to) - Date.parse(from) > 366 * 86400_000
  )
    fail("Choose a positive value and a claim period of at most 366 days");
  const [policy] =
    await c.db`select * from claim_types where id=${uuid(b.typeId)} and effective_from<=${new Date(c.now)} and effective_to>${new Date(c.now)}`;
  if (!policy) fail("Claim type is not currently effective");
  const reference = text(b.reference, "Claim reference", 120);
  const quantity = claimQuantity(b);
  if (b.earningId && quantity.quantity != null)
    fail(
      "Earned rebates already freeze quantity; use source-line quantities only for a direct evidence claim",
    );
  if (b.earningId) {
    const [e] =
      await c.db`select * from promotion_earnings where id=${uuid(b.earningId)}`;
    if (
      !e ||
      e.campaign_version_id !== b.campaignVersionId ||
      e.outlet_id !== (b.outletId ?? null) ||
      e.account_key !== party ||
      Number(e.reversed_centavos) > 0
    )
      fail("Earning does not match the claim facts");
  }
  const [r] =
    await c.db`insert into claims(id,reference,claimant_party_type,claimant_party_id,claimant_name,type_id,campaign_version_id,earning_id,outlet_id,period_from,period_to,amount_centavos,created_by,product_id,uom,quantity_units)
    values(${sourceId},${reference},${type},${party},${name},${policy.id},${b.campaignVersionId ? uuid(b.campaignVersionId) : null},${b.earningId ? uuid(b.earningId) : null},${b.outletId ? uuid(b.outletId) : null},${from},${to},${amount},${c.actor.subject},${quantity.quantity != null ? uuid(quantity.productId) : null},${quantity.quantity != null ? text(quantity.uom, "Source selling UOM", 32) : null},${quantity.quantity}) returning *`;
  await event(c, r, "submitted");
  return { id: r.id, status: r.status };
}
/** @param {any} c @param {any} r @param {any} source */
function matches(c, r, source) {
  if (!source || !source.verified) return false;
  if (
    ["source_document", "secondary_sale", "attendance"].includes(source.kind) &&
    (!source.partyId || !source.partyType)
  )
    return false;
  const day = manilaDate(source.occurredAt);
  return (
    day >=
      String(
        r.period_from instanceof Date
          ? r.period_from.toISOString()
          : r.period_from,
      ).slice(0, 10) &&
    day <=
      String(
        r.period_to instanceof Date ? r.period_to.toISOString() : r.period_to,
      ).slice(0, 10) &&
    (!r.outlet_id || r.outlet_id === source.outletId) &&
    (!source.campaignVersionId ||
      r.campaign_version_id === source.campaignVersionId) &&
    (!source.partyId ||
      (r.claimant_party_id === source.partyId &&
        r.claimant_party_type === source.partyType))
  );
}
/** Shared immutable source linker for office and claimant intake. @param {any} c @param {any} r @param {any} b */
export async function attachClaimEvidence(c, r, b) {
  if (!["submitted", "needs_evidence"].includes(r.status))
    fail("Evidence is locked after validation");
  const kind = choice(b.kind, EVIDENCE_KINDS, "Evidence kind"),
    requested = uuid(b.sourceId),
    source = await readEvidence(
      {
        ...c,
        claimEvidenceScope: {
          partyType: r.claimant_party_type,
          partyId: r.claimant_party_id,
        },
      },
      kind,
      requested,
    ),
    id =
      kind === "secondary_sale"
        ? uuid(source?.sourceId ?? requested)
        : requested;
  if (!matches(c, r, source))
    fail("Evidence is not verified or does not match this claim");
  await c.db`select pg_advisory_xact_lock(hashtextextended(${"tpm:source:" + kind + ":" + id},0))`;
  await c.db`select pg_advisory_xact_lock(hashtextextended(${"tpm:proof:" + source.fingerprint},0))`;
  const [same] =
    await c.db`select id from claim_evidence where claim_id=${r.id} and kind=${kind} and source_id=${id}`;
  if (!same) {
    const [duplicate] =
      await c.db`select id from claim_evidence where fingerprint=${source.fingerprint} or (kind=${kind} and source_id=${id}) union all select e.id from claim_evidence_revisions v join claim_evidence e on e.id=v.evidence_id where v.fingerprint=${source.fingerprint} limit 1`;
    if (duplicate) fail("Evidence was already used by another claim");
    await c.db`insert into claim_evidence(claim_id,kind,source_id,fingerprint,snapshot) values(${r.id},${kind},${id},${text(source.fingerprint, "Evidence fingerprint", 200)},${source})`;
  }
  await event(c, r, "evidence_added", { kind });
  await c.db`update claims set last_material_by=${c.actor.subject},updated_at=now() where id=${r.id}`;
  return { id: r.id };
}
/** Bounded packet intake is atomic with its source links; monetary validation stays independent. @param {any} c @param {any} b */
export async function submitClaimPacket(c, b) {
  if (!Array.isArray(b.sources) || b.sources.length > 20)
    fail("Choose at most 20 source records");
  const result = await submitClaim(c, b),
    r = await claim(c, result.id);
  for (const source of [...b.sources].sort((a, b) =>
    `${a.kind}:${a.sourceId}`.localeCompare(`${b.kind}:${b.sourceId}`),
  ))
    await attachClaimEvidence(c, r, source);
  return result;
}
/** F-506 immutable validation re-reads authoritative facts; a photo alone never proves payable money.
 * @param {any} c @param {any} r */
export async function validateClaim(c, r) {
  const [policy] = await c.db`select * from claim_types where id=${r.type_id}`;
  const links =
    await c.db`select e.*,coalesce(v.snapshot,e.snapshot) as snapshot from claim_evidence e left join lateral(select snapshot from claim_evidence_revisions where evidence_id=e.id order by seq desc limit 1)v on true where e.claim_id=${r.id} order by e.kind,e.source_id`;
  /** @type {string[]} */ const reasons = [];
  /** @type {any[]} */ const sources = [];
  for (const link of links) {
    const source = await readEvidence(
      {
        ...c,
        claimEvidenceScope: {
          partyType: r.claimant_party_type,
          partyId: r.claimant_party_id,
        },
      },
      link.kind,
      link.source_id,
    );
    if (
      !matches(c, r, source) ||
      canonicalJson(comparableEvidence(source, link.snapshot)) !==
        canonicalJson(link.snapshot)
    )
      reasons.push(`Evidence changed or does not match: ${link.kind}`);
    else sources.push(comparableEvidence(source, link.snapshot));
  }
  for (const kind of policy.required_evidence)
    if (!sources.some((s) => s.kind === kind))
      reasons.push(`Missing verified ${kind}`);
  let earning = null;
  if (r.earning_id) {
    [earning] =
      await c.db`select * from promotion_earnings where id=${r.earning_id} for update`;
    if (
      !earning ||
      earning.campaign_version_id !== r.campaign_version_id ||
      earning.outlet_id !== r.outlet_id ||
      earning.account_key !== r.claimant_party_id ||
      Number(earning.reversed_centavos) > 0 ||
      !matches(c, r, {
        verified: true,
        outletId: earning.outlet_id,
        campaignVersionId: earning.campaign_version_id,
        occurredAt: new Date(earning.earned_at).getTime(),
      })
    )
      reasons.push("Earning does not match the period, campaign or claimant");
    const [allocated] =
      await c.db`select coalesce(sum(amount_centavos),0) as n from claims where earning_id=${r.earning_id} and id<>${r.id} and status in ('validated','approved','part_settled','settled')`;
    if (
      !earning ||
      BigInt(allocated.n) + BigInt(r.amount_centavos) >
        BigInt(earning.amount_centavos) - BigInt(earning.reversed_centavos)
    )
      reasons.push("Claim exceeds unclaimed earned value");
  } else {
    const proven = provenClaimValue(sources, r);
    if (proven === null || BigInt(r.amount_centavos) > proven)
      reasons.push(
        r.quantity_units != null
          ? "Source SKU, selling unit, quantity or prorated value does not match"
          : "No authoritative source proves the claimed value",
      );
    if (r.quantity_units != null) {
      const line = sources.find(
        (s) => s.productId === r.product_id && s.uom === r.uom,
      );
      if (
        line?.outletId &&
        sources.some((s) => s.outletId && s.outletId !== line.outletId)
      )
        reasons.push("Execution evidence belongs to another source store");
    }
  }
  if (
    r.campaign_version_id &&
    !sources.some((s) => s.campaignVersionId === r.campaign_version_id)
  )
    reasons.push("Campaign execution evidence is missing");
  const content = {
    claimId: r.id,
    amount: String(r.amount_centavos),
    policyId: policy.id,
    required: policy.required_evidence,
    ...(r.last_material_by ? { lastMaterialBy: r.last_material_by } : {}),
    ...(r.quantity_units != null
      ? {
          product: r.product_id,
          uom: r.uom,
          quantity: String(r.quantity_units),
        }
      : {}),
    sources,
    earning: earning
      ? {
          id: earning.id,
          amount: String(earning.amount_centavos),
          reversed: String(earning.reversed_centavos),
        }
      : null,
  };
  const hash = sha256Hex(canonicalJson(content));
  return applyExecutionOverride(c, r, policy, {
    passed: !reasons.length,
    reasons,
    hash,
    baseHash: hash,
    exceptionEligible: executionExceptionEligible(policy, reasons),
  });
}
/** F-409/F-505 portal seam. Partner owners supply the effective membership grant, not a second claim object.
 * @param {any} c @param {{partyType:string,partyId:string}} q */
export async function claimantClaims(c, q) {
  await seams.authorizeClaimant(c, q.partyType, q.partyId);
  return {
    rows: bounded(
      await c.db`select c.*,t.code as type_code from claims c join claim_types t on t.id=c.type_id where c.claimant_party_type=${q.partyType} and c.claimant_party_id=${q.partyId} order by c.created_at desc limit 501`,
    ).map(claimView),
  };
}
/** @param {any} r */
export const claimView = (r) => ({
  id: r.id,
  reference: r.reference,
  partyType: r.claimant_party_type,
  partyName: r.claimant_name,
  type: r.type_code,
  status: r.status,
  amountCentavos: Number(r.amount_centavos),
  ...(r.quantity_units != null
    ? {
        productId: r.product_id,
        uom: r.uom,
        quantityUnits: Number(r.quantity_units),
      }
    : {}),
  periodFrom: String(
    r.period_from instanceof Date ? r.period_from.toISOString() : r.period_from,
  ).slice(0, 10),
  periodTo: String(
    r.period_to instanceof Date ? r.period_to.toISOString() : r.period_to,
  ).slice(0, 10),
  campaignVersionId: r.campaign_version_id,
  earningId: r.earning_id,
  outletId: r.outlet_id,
  createdAt: new Date(r.created_at).getTime(),
});
/** @param {any} router */
export function installClaims(router) {
  for (const action of ["amend", "refresh-evidence"])
    router.post(`/api/v1/tpm/claims/${action}`, (/** @type {any} */ c) =>
      command(
        c,
        `claim.${action}`,
        c.body,
        (cc) => office(cc, "order.encode"),
        async (cc) => {
          const b = c.body,
            r = await claim(cc, b.id, true);
          if (
            ![
              "submitted",
              "needs_evidence",
              "validated",
              "rejected",
              "approved",
            ].includes(r.status)
          )
            fail("Only an unpaid claim can be revised");
          const [paid] =
            await cc.db`select 1 from claim_settlements where claim_id=${r.id} and status in ('pending','acknowledged') limit 1`;
          if (paid)
            fail(
              "Reconcile the related SAP settlement before modifying this claim",
            );
          const reason = text(b.reason, "Revision reason", 1000);
          if (action === "amend") {
            const amount = integer(b.amountCentavos);
            if (!amount) fail("Choose a positive claim amount");
            const quantity = b.quantityUnits ?? r.quantity_units;
            if (
              b.quantityUnits != null &&
              (!Number.isSafeInteger(b.quantityUnits) || b.quantityUnits <= 0)
            )
              fail("Choose positive whole source units");
            if (r.quantity_units == null && b.quantityUnits != null)
              fail("This claim has no source SKU/UOM quantity contract");
            await cc.db`update claims set amount_centavos=${amount},quantity_units=${quantity},updated_at=now() where id=${r.id}`;
          } else {
            const kind = choice(b.kind, EVIDENCE_KINDS, "Evidence kind"),
              id = uuid(b.sourceId),
              source = await readEvidence(
                {
                  ...cc,
                  claimEvidenceScope: {
                    partyType: r.claimant_party_type,
                    partyId: r.claimant_party_id,
                  },
                },
                kind,
                id,
              );
            if (!matches(cc, r, source))
              fail("The new source version does not match this claim");
            const [link] =
              await cc.db`select id from claim_evidence where claim_id=${r.id} and kind=${kind} and source_id=${id}`;
            if (!link) fail("Choose existing linked evidence");
            await cc.db`select pg_advisory_xact_lock(hashtextextended(${"tpm:proof:" + source.fingerprint},0))`;
            const [duplicate] =
              await cc.db`select id from claim_evidence where claim_id<>${r.id} and fingerprint=${source.fingerprint} union all select e.id from claim_evidence_revisions v join claim_evidence e on e.id=v.evidence_id where e.claim_id<>${r.id} and v.fingerprint=${source.fingerprint} limit 1`;
            if (duplicate) fail("This proof belongs to another claim");
            await cc.db`insert into claim_evidence_revisions(evidence_id,fingerprint,snapshot,reason,actor_subject)values(${link.id},${source.fingerprint},${source},${reason},${cc.actor.subject})`;
          }
          await cc.db`update claims set status='needs_evidence',validation_hash=null,validated_by=null,approved_by=null,last_material_by=${cc.actor.subject},updated_at=now() where id=${r.id}`;
          await event(
            cc,
            r,
            action === "amend" ? "amended" : "source_refreshed",
            { reason },
          );
          return { id: r.id, status: "needs_evidence" };
        },
      ),
    );
  router.get("/api/v1/tpm/claims/source-file", async (/** @type {any} */ c) => {
    await office(c);
    const r = await claim(c, c.url.searchParams.get("id")),
      id = uuid(c.url.searchParams.get("sourceId")),
      source = await readEvidence(c, "source_document", id);
    if (!matches(c, r, source)) fail("Document does not match this claim");
    const [doc] =
      await c.db`select content,mime,sha256,distributor_id from distributor_documents where id=${id}`;
    if (
      !doc ||
      source.partyType !== "distributor" ||
      source.partyId !== doc.distributor_id ||
      source.fingerprint !== `distributor-document:${id}:${doc.sha256}` ||
      sha256Hex(doc.content) !== doc.sha256
    )
      fail("Original document is unavailable");
    return new Response(doc.content, {
      headers: {
        "content-type": ["application/pdf", "image/jpeg", "image/png"].includes(
          doc.mime,
        )
          ? doc.mime
          : "application/octet-stream",
        "content-disposition": 'attachment; filename="claim-source"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
  router.get("/api/v1/tpm/claims/photo", async (/** @type {any} */ c) => {
    await office(c);
    const r = await claim(c, c.url.searchParams.get("id")),
      source = await readEvidence(
        c,
        "photo",
        uuid(c.url.searchParams.get("sourceId")),
      );
    if (!matches(c, r, source)) fail("Photo does not match this claim");
    const [stored] =
      await c.db`select path,sha256,mime from files where id=${source.storageId} and status='stored'`;
    if (
      !stored ||
      source.fingerprint !== `photo:${stored.sha256}` ||
      !HEX64_RE.test(stored.sha256) ||
      stored.mime !== "image/jpeg" ||
      stored.path !== `${stored.sha256.slice(0, 2)}/${stored.sha256}`
    )
      fail("Stored photo is unavailable");
    const file = Bun.file(join(filesDir(c.env), stored.path));
    if (!(await file.exists()) || file.size > MAX_MEDIA_BYTES)
      fail("Stored photo is unavailable");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sha256Hex(bytes) !== stored.sha256)
      fail("Stored photo failed its digest check");
    return new Response(bytes, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
  router.post("/api/v1/tpm/claims/execution-override", (/** @type {any} */ c) =>
    command(
      c,
      "claim.execution_override",
      c.body,
      (cc) => office(cc, "order.approve"),
      async (cc) => {
        const r = await claim(cc, c.body.id, true);
        if (
          ![
            "submitted",
            "needs_evidence",
            "validated",
            "approved",
            "part_settled",
          ].includes(r.status)
        )
          fail("Choose an unsettled claim");
        const [policy] =
          await cc.db`select * from claim_types where id=${r.type_id}`;
        const base = await validateClaim(cc, r),
          id = await approveExecutionOverride(cc, r, policy, base, c.body),
          result = await validateClaim(cc, r);
        if (!result.passed)
          fail("Exception is not authorized for the current source facts");
        const status = ["approved", "part_settled"].includes(r.status)
          ? r.status
          : "validated";
        await cc.db`update claims set status=${status},validation_hash=${result.hash},validated_by=${cc.actor.subject},updated_at=now() where id=${r.id}`;
        await event(cc, r, "execution_exception_approved", {
          overrideId: id,
          waivedReasons: base.reasons,
        });
        return { id, status };
      },
    ),
  );
  router.get(
    "/api/v1/tpm/claims/evidence-options",
    async (/** @type {any} */ c) => {
      await office(c);
      const r = await claim(c, c.url.searchParams.get("id"));
      const rows = await claimSourceOptions(c, r),
        visible = [];
      for (const e of rows.slice(0, 100)) {
        const source = await readEvidence(c, e.kind, e.id);
        if (!matches(c, r, source)) continue;
        visible.push({
          id: e.id,
          kind: e.kind,
          label: `${e.label} · ${manilaDate(new Date(e.at))}`,
          snapshot: source,
          ...(e.kind === "photo"
            ? {
                photoUrl: `/api/v1/tpm/claims/photo?id=${r.id}&sourceId=${e.id}`,
              }
            : {}),
        });
      }
      return {
        truncated: rows.length > 100,
        rows: visible,
      };
    },
  );

  router.get("/api/v1/tpm/claims/mine", (/** @type {any} */ c) =>
    claimantClaims(c, {
      partyType: choice(
        c.url.searchParams.get("partyType"),
        PARTY_TYPES,
        "Claimant type",
      ),
      partyId: text(c.url.searchParams.get("partyId"), "Claimant party", 160),
    }),
  );
  router.get("/api/v1/tpm/notifications", async (/** @type {any} */ c) => {
    const type = choice(
        c.url.searchParams.get("partyType"),
        PARTY_TYPES,
        "Claimant type",
      ),
      id = text(c.url.searchParams.get("partyId"), "Claimant party", 160);
    await seams.authorizeClaimant(c, type, id);
    return {
      rows: bounded(
        await c.db`select id,claim_id,message,read_at,created_at from claim_notifications where party_type=${type} and party_id=${id} order by created_at desc limit 501`,
      ),
    };
  });

  router.post("/api/v1/tpm/policies/end", (/** @type {any} */ c) =>
    command(
      c,
      "policy.end",
      c.body,
      (cc) => office(cc, "masterdata.manage"),
      async (cc) => {
        const b = c.body,
          id = uuid(b.id),
          to = instant(b.effectiveTo);
        if (to.getTime() < cc.now)
          fail("Policy retirement must be prospective");
        let rows;
        if (b.kind === "claim_type")
          rows =
            await cc.db`update claim_types set effective_to=${to},updated_at=now() where id=${id} and effective_from<${to} and effective_to>=${to} returning id`;
        else if (b.kind === "approval")
          rows =
            await cc.db`update claim_approval_rules set effective_to=${to},updated_at=now() where id=${id} and effective_from<${to} and effective_to>=${to} returning id`;
        else if (b.kind === "incentive")
          rows =
            await cc.db`update incentive_plans set effective_to=${to},updated_at=now() where id=${id} and effective_from<${to} and effective_to>=${to} returning id`;
        else fail("Choose a policy kind");
        if (!rows?.length)
          fail("Choose a live policy and a retirement inside its period");
        await changed(cc, "policy.retired", id);
        return { id };
      },
    ),
  );

  router.get("/api/v1/tpm/claims", async (/** @type {any} */ c) => {
    await office(c);
    return {
      rows: bounded(
        await c.db`select c.*,t.code as type_code from claims c join claim_types t on t.id=c.type_id order by c.created_at desc limit 501`,
      ).map(claimView),
    };
  });
  router.get("/api/v1/tpm/claims/detail", async (/** @type {any} */ c) => {
    await office(c);
    const r = await claim(c, c.url.searchParams.get("id"));
    return {
      ...claimView(r),
      validation: await validateClaim(c, r),
      overrides:
        await c.db`select reason,evidence_reference,waived_reasons,created_at from claim_execution_overrides where claim_id=${r.id} order by created_at`,
      evidence:
        await c.db`select e.kind,e.source_id,coalesce(v.snapshot,e.snapshot) as snapshot from claim_evidence e left join lateral(select snapshot from claim_evidence_revisions where evidence_id=e.id order by seq desc limit 1)v on true where e.claim_id=${r.id}`,
      events:
        await c.db`select action,details,created_at from claim_events where claim_id=${r.id} order by created_at`,
      settlements:
        await c.db`select id,method,status,amount_centavos from claim_settlements where claim_id=${r.id}`,
    };
  });
  router.get("/api/v1/tpm/policies", async (/** @type {any} */ c) => {
    await office(c);
    return {
      types: bounded(
        await c.db`select * from claim_types order by code,effective_from desc limit 501`,
      ),
      approvals: bounded(
        await c.db`select * from claim_approval_rules order by min_centavos limit 501`,
      ),
    };
  });
  router.post("/api/v1/tpm/claims/submit", (/** @type {any} */ c) =>
    command(
      c,
      "claim.submit",
      c.body,
      (cc) => seams.authorizeClaimant(cc, c.body.partyType, c.body.partyId),
      (cc) => submitClaim(cc, c.body),
    ),
  );
  router.post("/api/v1/tpm/policies/save", (/** @type {any} */ c) =>
    command(
      c,
      "policy.save",
      c.body,
      (cc) => office(cc, "masterdata.manage"),
      async (cc) => {
        const b = c.body,
          from = instant(b.effectiveFrom),
          to = instant(b.effectiveTo);
        if (to <= from) fail("Policy end must follow start");
        if (b.kind === "claim_type") {
          const hours = b.escalationHours ?? 48;
          if (
            !Number.isInteger(hours) ||
            hours < 1 ||
            hours > 720 ||
            (b.emailNotifications != null &&
              typeof b.emailNotifications !== "boolean")
          )
            fail(
              "Choose 1–720 inactivity hours and an explicit email preference",
            );
          const required = b.requiredEvidence;
          if (
            !Array.isArray(required) ||
            !required.length ||
            required.length > 6 ||
            required.some((x) => !EVIDENCE_KINDS.includes(x))
          )
            fail("Choose required evidence types");
          const [r] =
            await cc.db`insert into claim_types(code,effective_from,effective_to,required_evidence,source,allow_execution_override,escalation_hours,email_notifications) values(${text(b.code, "Type code", 80)},${from},${to},${required},'office',${b.allowExecutionOverride === true},${hours},${b.emailNotifications !== false}) returning id`;
          await changed(cc, "claim_type.saved", r.id);
          return { id: r.id };
        }
        if (b.kind !== "approval") fail("Choose a policy kind");
        const min = integer(b.minCentavos),
          max = integer(b.maxCentavos),
          roles = b.approverRoles;
        if (
          max < min ||
          !Array.isArray(roles) ||
          !roles.length ||
          roles.some((x) => !["super_admin", "manager", "approver"].includes(x))
        )
          fail("Choose value bands and Finance approver roles");
        const [r] =
          await cc.db`insert into claim_approval_rules(name,party_type,min_centavos,max_centavos,approver_roles,effective_from,effective_to,source) values(${text(b.name, "Rule name", 160)},${choice(b.partyType, [...PARTY_TYPES, "all"], "Claimant type")},${min},${max},${roles},${from},${to},'office') returning id`;
        await changed(cc, "claim_approval.saved", r.id);
        return { id: r.id };
      },
    ),
  );
  for (const action of ["evidence", "validate", "approve", "reject", "settle"])
    router.post(`/api/v1/tpm/claims/${action}`, (/** @type {any} */ c) =>
      command(
        c,
        `claim.${action}`,
        c.body,
        (cc) =>
          office(
            cc,
            ["approve", "reject", "settle"].includes(action)
              ? "order.approve"
              : "order.encode",
          ),
        async (cc) => {
          const b = c.body,
            r = await claim(cc, b.id, true);
          if (action === "evidence") {
            return attachClaimEvidence(cc, r, b);
          }
          if (action === "validate") {
            if (
              !["submitted", "needs_evidence", "validated"].includes(r.status)
            )
              fail("Claim is not awaiting validation");
            const result = await validateClaim(cc, r);
            await cc.db`insert into claim_validation_runs(claim_id,passed,results,content_hash,actor_subject) values(${r.id},${result.passed},${result.reasons},${result.hash},${cc.actor.subject})`;
            await cc.db`update claims set status=${result.passed ? "validated" : "needs_evidence"},validated_by=${cc.actor.subject},validation_hash=${result.hash},updated_at=now() where id=${r.id}`;
            await event(cc, r, result.passed ? "validated" : "needs_evidence", {
              reasons: result.reasons,
            });
            return result;
          }
          if (
            r.created_by === cc.actor.subject ||
            r.last_material_by === cc.actor.subject
          )
            fail(
              "You cannot approve or settle your own claim",
              "self_approval",
            );
          const rules =
            await cc.db`select * from claim_approval_rules where (party_type='all' or party_type=${r.claimant_party_type}) and min_centavos<=${r.amount_centavos} and max_centavos>=${r.amount_centavos} and effective_from<=${new Date(cc.now)} and effective_to>${new Date(cc.now)}`;
          if (
            rules.length !== 1 ||
            !rules[0].approver_roles.includes(cc.actor.role)
          )
            fail(
              "Claim needs an approver in its value band",
              "approval_required",
            );
          if (action === "reject") {
            if (
              !["submitted", "needs_evidence", "validated"].includes(r.status)
            )
              fail("This claim cannot be rejected");
            await cc.db`update claims set status='rejected',updated_at=now() where id=${r.id}`;
            await event(cc, r, "rejected", {
              reason: text(b.reason, "Rejection reason"),
            });
            return { id: r.id, status: "rejected" };
          }
          if (action === "approve") {
            if (r.status !== "validated")
              fail("Validate the evidence before approval");
            const result = await validateClaim(cc, r);
            if (!result.passed || result.hash !== r.validation_hash)
              fail(
                "Evidence or earned value changed; revalidation is required",
              );
            await cc.db`update claims set status='approved',approved_by=${cc.actor.subject},updated_at=now() where id=${r.id}`;
            await event(cc, r, "approved");
            return { id: r.id, status: "approved" };
          }
          if (!["approved", "part_settled"].includes(r.status))
            fail("Only approved claims may settle");
          const validation = await validateClaim(cc, r);
          if (!validation.passed || validation.hash !== r.validation_hash)
            fail(
              "Source evidence changed; reconcile and reauthorize this claim before further SAP settlement",
            );
          const amount = integer(b.amountCentavos),
            method = choice(
              b.method,
              ["credit_memo", "payment"],
              "Settlement method",
            );
          const [sum] =
            await cc.db`select coalesce(sum(amount_centavos),0) as n from claim_settlements where claim_id=${r.id} and status in ('pending','acknowledged')`;
          if (
            !amount ||
            BigInt(sum.n) + BigInt(amount) > BigInt(r.amount_centavos)
          )
            fail("Settlement exceeds the unsettled claim value");
          const [s] =
            await cc.db`insert into claim_settlements(claim_id,amount_centavos,method,created_by) values(${r.id},${amount},${method},${cc.actor.subject}) returning id`;
          await posting(cc, {
            sourceKey: `claim-settlement:${s.id}`,
            kind: method,
            settlementId: s.id,
            earningId: r.earning_id,
            amountCentavos: amount,
            currency: "PHP",
            claimId: r.id,
            partyType: r.claimant_party_type,
            partyId: r.claimant_party_id,
          });
          await event(cc, r, "settlement_requested", {
            amountCentavos: amount,
            method,
          });
          return { id: s.id, status: "pending_sap" };
        },
      ),
    );
}
