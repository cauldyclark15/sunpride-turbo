import { tx } from "@sunpride/db/client";
import { actorFor } from "../../core/context.js";
import { requireCapability } from "../../core/capabilities.js";
import { outletOwnerUnit, territoryOwnerUnit } from "../org/scope.js";
import { recordChange } from "../../core/sync.js";
import {
  authorize,
  date,
  digest,
  fail,
  integer,
  list,
  text,
  uuid,
  PARTNER_GRANTS,
} from "./model.js";
import { sapCreditCheck, enqueueSapPosting } from "./seams.js";
import { ensurePartnerDeviceScope } from "./identity-seam.js";

/** F-401: create an applicant organization. @param {any} c */
export async function createDistributor(c) {
  const b = c.body ?? {};
  const code = text(b.code, "Distributor code", 50),
    name = text(b.name, "Name"),
    unit = uuid(b.orgUnitId);
  const row = await tx(c.db, async (db) => {
    const actor = c.actor ? await actorFor(db, c.actor.userId) : null;
    await requireCapability({ ...c, db, actor }, "integration.manage", unit);
    const [u] =
      await db`select id from org_units where id=${unit} and status='active' and deleted_at is null`;
    if (!u) fail("Choose an active supervising unit");
    const [old] = await db`select * from distributors where code=${code}`;
    if (old) {
      await authorize({ ...c, db, actor }, old.id, "read", true);
      if (old.name !== name || old.org_unit_id !== unit)
        fail("Code belongs to a different distributor", "conflict", 409);
      return old;
    }
    const [d] =
      await db`insert into distributors(code,name,org_unit_id,source) values(${code},${name},${unit},'office') returning *`;
    await db`insert into distributor_events(distributor_id,actor_id,action,entity_id) values(${d.id},${actor?.profileId},'F-401.create',${d.id})`;
    await recordChange(db, {
      entity: "distributor",
      entityId: d.id,
      scopeKey: `partner:${d.id}`,
    });
    return d;
  });
  return { id: row.id, name: row.name };
}
/** F-402: one membership, effective grants; existing employee accounts cannot be hijacked.
 * @param {any} c @param {any} d @param {any} b */
export async function invite(c, d, b) {
  const email = text(b.email, "Email").toLowerCase(),
    name = text(b.name, "Name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Enter a valid email");
  const grants = list(b.grants, PARTNER_GRANTS.length).map((g) => text(g));
  if (
    !grants.includes("read") ||
    grants.some((g) => !PARTNER_GRANTS.includes(g))
  )
    fail("Choose supported partner grants");
  const deviceScope = await ensurePartnerDeviceScope(c, d);
  const [existing] =
    await c.db`select * from profiles where lower(email)=${email} for update`;
  if (existing && existing.role !== "distributor")
    fail(
      "An employee account cannot become a distributor account",
      "conflict",
      409,
    );
  const [p] = existing
    ? [existing]
    : await c.db`insert into profiles(name,email,role,status,employment_type,org_unit_id) values(${name},${email},'distributor','active','third_party',${deviceScope}) returning *`;
  const [current] =
    await c.db`select * from distributor_users where profile_id=${p.id} and (effective_to is null or effective_to>now())`;
  if (current && current.distributor_id !== d.id)
    fail("Account already belongs to another distributor", "conflict", 409);
  if (current)
    await c.db`update distributor_users set effective_to=now() where id=${current.id}`;
  // SEAM(ORG): retire native cursors when partner grants or membership change.
  await c.db`update profiles set org_unit_id=${deviceScope},scope_epoch=scope_epoch+1 where id=${p.id}`;
  const [m] =
    await c.db`insert into distributor_users(distributor_id,profile_id,grants) values(${d.id},${p.id},${c.db.array(grants, "TEXT")}) returning id`;
  if (!p.user_id) {
    await c.db`update access_invitations set status='revoked' where lower(email)=${email} and status='pending'`;
    await c.db`insert into access_invitations(email,name,role,status,invited_by,invited_at,profile_id) values(${email},${name},'distributor','pending',${c.actor.subject},now(),${p.id})`;
  }
  return { id: m.id, profileId: p.id, email, grants };
}
/** @param {any} c @param {any} d @param {any} b */
export async function revoke(c, d, b) {
  const [m] =
    await c.db`update distributor_users set effective_to=now() where id=${uuid(b.membershipId)} and distributor_id=${d.id} and effective_from<now() and (effective_to is null or effective_to>now()) returning id`;
  if (!m) fail("Active membership not found");
  await c.db`update profiles set scope_epoch=scope_epoch+1 where id=(select profile_id from distributor_users where id=${m.id})`;
  return { id: m.id };
}
/** F-402: immutable full snapshots with monotonic replay, exact shared outlet ids and SAP provenance.
 * @param {any} c @param {any} d @param {any} b */
export async function syncMaster(c, d, b) {
  const version = integer(b.version, 1),
    sourceKey = text(b.sourceKey),
    payload = b.payload;
  if (
    !["sample", "sap"].includes(b.source) ||
    !payload ||
    typeof payload !== "object"
  )
    fail("SAP source and master payload required");
  if (b.source === "sample" && d.source !== "sample")
    fail("Mock masters are only allowed for marked sample distributors");
  const from = new Date(b.effectiveFrom);
  if (!Number.isFinite(from.getTime()) || from.getTime() > c.now)
    fail("Master effective date must not be in the future");
  const hash = digest({
    source: b.source,
    sourceKey,
    payload,
    effectiveFrom: from.toISOString(),
  });
  const [old] =
    await c.db`select * from distributor_master_versions where distributor_id=${d.id} order by version desc limit 1`;
  if (old && version <= Number(old.version)) {
    if (version === Number(old.version) && old.payload_hash === hash)
      return { id: old.id, duplicate: true };
    fail("Older or conflicting SAP master version", "version_conflict", 409);
  }
  if (old && from.getTime() < new Date(old.effective_from).getTime())
    fail("Master effective date precedes its previous version");
  const products = list(payload.products, 1000),
    outlets = list(payload.outlets, 2000);
  if (!products.length || !payload.terms || !text(payload.terms.paymentTerms))
    fail("Catalog and payment terms required");
  integer(payload.terms.deliveryLeadDays, 0, 90);
  const seen = new Set();
  for (const p of products) {
    uuid(p.productId);
    text(p.uom);
    integer(p.unitsPerUom, 1, 1000000);
    integer(p.priceCentavos);
    integer(p.availableBase);
    if (seen.has(p.productId)) fail("Repeated catalog product");
    seen.add(p.productId);
    const [row] =
      await c.db`select id from products where id=${p.productId} and active and deleted_at is null`;
    if (!row) fail("Master references an unavailable product");
  }
  const stores = new Set();
  for (const o of outlets) {
    uuid(o.outletId);
    if (stores.has(o.outletId)) fail("Repeated outlet grant");
    stores.add(o.outletId);
    const [row] =
      await c.db`select id from outlets where id=${o.outletId} and deleted_at is null`;
    if (!row) fail("Master references an unknown shared outlet");
    const owner = await outletOwnerUnit(c.db, o.outletId, c.now);
    if (!owner && c.actor.role !== "super_admin")
      fail("Outlet ownership needs setup");
    await requireCapability(c, "outlet.read", owner);
    if (o.territoryId) {
      const [t] =
        await c.db`select id from territories where id=${uuid(o.territoryId)} and deleted_at is null`;
      if (!t) fail("Unknown shared territory");
      const territoryOwner = await territoryOwnerUnit(
        c.db,
        o.territoryId,
        c.now,
      );
      if (!territoryOwner && c.actor.role !== "super_admin")
        fail("Territory ownership needs setup");
      await requireCapability(c, "territory.read", territoryOwner);
    }
  }
  list(payload.schemes ?? [], 100);
  if (old) {
    await c.db`update distributor_master_versions set effective_to=${from} where id=${old.id}`;
    await c.db`update distributor_outlets set effective_to=${from} where distributor_id=${d.id} and effective_to is null`;
  }
  const [m] =
    await c.db`insert into distributor_master_versions(distributor_id,source,source_key,version,payload_hash,payload,effective_from) values(${d.id},${b.source},${sourceKey},${version},${hash},${payload},${from}) returning id`;
  for (const o of outlets)
    await c.db`insert into distributor_outlets(distributor_id,outlet_id,territory_id,master_version_id,effective_from) values(${d.id},${o.outletId},${o.territoryId ?? null},${m.id},${from})`;
  return {
    id: m.id,
    version,
    products: products.length,
    outlets: outlets.length,
  };
}
/** F-405/F-411/F-413/F-416: configurable, versioned policy; no magic business defaults in readers.
 * @param {any} c @param {any} d @param {any} b */
export async function setPolicy(c, d, b) {
  const p = b.settings;
  if (!p || typeof p !== "object") fail("Policy settings required");
  for (const k of [
    "doiWindowDays",
    "stockFreshDays",
    "nearExpiryDays",
    "understockDays",
    "overstockDays",
    "creditMaxAgeSeconds",
    "reconciliationToleranceBase",
  ])
    integer(
      p[k],
      k === "doiWindowDays" || k === "creditMaxAgeSeconds" ? 1 : 0,
      86400,
    );
  if (p.understockDays >= p.overstockDays)
    fail("Overstock threshold must exceed understock");
  list(p.requiredDocuments, 20).forEach((v) => {
    if (!["registration", "tax", "credit"].includes(v))
      fail("Unsupported accreditation document type");
  });
  list(p.claimTypes, 20).forEach((v) => {
    text(v.kind);
    integer(v.minimumEvidence, 1, 20);
  });
  const weights = p.scorecardWeights;
  if (
    !weights ||
    Object.keys(weights).sort().join(",") !==
      "coverage,growth,infrastructure,manpower,payment,stock,submission" ||
    Object.values(weights).some(
      (v) => !Number.isSafeInteger(v) || Number(v) < 0,
    ) ||
    Object.values(weights).reduce((n, v) => n + Number(v), 0) !== 100
  )
    fail("Seven scorecard weights must total 100");
  const [old] =
    await c.db`select * from distributor_policies where distributor_id=${d.id} and effective_to is null`;
  if (old)
    await c.db`update distributor_policies set effective_to=now() where id=${old.id}`;
  const [row] =
    await c.db`insert into distributor_policies(distributor_id,version,settings,effective_from) values(${d.id},${Number(old?.version ?? 0) + 1},${p},now()) returning id,version`;
  return row;
}
/** @param {any} c @param {any} d @param {any} b */
export async function setLocation(c, d, b) {
  const code = text(b.code),
    name = text(b.name);
  if (!["warehouse", "van"].includes(b.kind)) fail("Choose warehouse or van");
  // VANOPS binds inventory IDs only after its partner owner model is integrated.
  const [row] =
    await c.db`insert into distributor_locations(distributor_id,code,name,kind) values(${d.id},${code},${name},${b.kind}) on conflict(distributor_id,code) do update set name=excluded.name,kind=excluded.kind,updated_at=now() returning id`;
  return row;
}
/** @param {any} c @param {any} d @param {any} b */
export async function apply(c, d, b) {
  if (d.status !== "applicant")
    fail("Only a new applicant can submit accreditation", "invalid_transition");
  const legalName = text(b.legalName),
    tax = text(b.taxReference),
    contact = text(b.contact);
  const [old] =
    await c.db`select id from distributor_applications where distributor_id=${d.id}`;
  if (old)
    fail(
      "Application already submitted; retain the reviewed record",
      "conflict",
      409,
    );
  const [a] =
    await c.db`insert into distributor_applications(distributor_id,legal_name,tax_reference,contact,submitted_by,stage) values(${d.id},${legalName},${tax},${contact},${c.actor.profileId},'submitted') returning id`;
  await c.db`update distributors set status='review',updated_at=now() where id=${d.id}`;
  return a;
}
/** F-401: independent validation, real-time seam assessment, exact signed agreement version then SAP-code request.
 * @param {any} c @param {any} d @param {any} b */
export async function reviewApplication(c, d, b) {
  const [a] =
    await c.db`select * from distributor_applications where distributor_id=${d.id} for update`;
  if (!a) fail("Submit an application first");
  if (a.submitted_by === c.actor.profileId)
    fail("Another person must review the application", "self_approval", 403);
  const { policy } = await import("./model.js");
  const p = await policy(c, d.id);
  let stage;
  if (b.action === "reject") {
    stage = "rejected";
    text(b.reason, "Reason");
  } else if (b.action === "validate" && a.stage === "submitted") {
    const docs =
      await c.db`select kind from distributor_documents where distributor_id=${d.id}`;
    if (
      p.requiredDocuments.some(
        (/** @type {string} */ k) =>
          !docs.some((/** @type {any} */ x) => x.kind === k),
      )
    )
      fail("Upload every required accreditation document");
    stage = "validated";
  } else if (b.action === "assess_credit" && a.stage === "validated") {
    const credit = await sapCreditCheck(c, d, 0);
    if (credit.status !== "within")
      fail("SAP credit is over limit, stale or unavailable", "credit_blocked");
    await c.db`update distributor_applications set credit_assessment=${credit} where id=${a.id}`;
    stage = "credit_assessed";
  } else if (b.action === "request_code" && a.stage === "agreement") {
    const req = await enqueueSapPosting(
      c,
      d,
      "business_partner",
      `application:${a.id}`,
      { applicationId: a.id, agreementHash: a.agreement_hash },
    );
    stage = req.acknowledgement?.customerCode ? "accredited" : "code_requested";
    if (stage === "accredited")
      await c.db`update distributors set status='accredited',sap_customer_code=${req.acknowledgement.customerCode},updated_at=now() where id=${d.id}`;
  } else
    fail(
      "Application action is not available at this stage",
      "invalid_transition",
    );
  await c.db`update distributor_applications set stage=${stage},reviewed_by=${c.actor.profileId},updated_at=now() where id=${a.id}`;
  if (stage === "rejected")
    await c.db`update distributors set status='rejected',updated_at=now() where id=${d.id}`;
  return { id: a.id, stage };
}
/** @param {any} c @param {any} d @param {any} b */
export async function acceptAgreement(c, d, b) {
  const documentId = uuid(b.documentId);
  const [a] =
    await c.db`select * from distributor_applications where distributor_id=${d.id} and stage='credit_assessed'`;
  const [doc] =
    await c.db`select id,sha256 from distributor_documents where distributor_id=${d.id} and kind='agreement' and published order by created_at desc,version desc,id desc limit 1`;
  if (
    !a ||
    !doc ||
    doc.id !== documentId ||
    doc.sha256 !== b.sha256 ||
    b.accepted !== true ||
    c.actor.role !== "distributor"
  )
    fail("Accept the exact published agreement as the distributor");
  await c.db`update distributor_applications set stage='agreement',agreement_document_id=${doc.id},agreement_hash=${doc.sha256},updated_at=now() where id=${a.id}`;
  return { id: a.id, stage: "agreement" };
}
/** F-402/F-415/F-416 SAP replication. Idempotent version/key, immutable conflicts; no local invented balances.
 * @param {any} c @param {any} d @param {any} b */
export async function syncFinancial(c, d, b) {
  if (
    !["sample", "sap"].includes(b.source) ||
    (b.source === "sample" && d.source !== "sample")
  )
    fail("Valid source required");
  const version = integer(b.version, 1);
  for (const item of list(b.arItems ?? [], 500)) {
    const key = text(item.sourceKey),
      balance = integer(item.balanceCentavos),
      invoice = text(item.invoiceNumber),
      due = date(item.dueDate);
    const [old] =
      await c.db`select * from distributor_ar_items where distributor_id=${d.id} and source_key=${key}`;
    if (old && Number(old.version) >= version) {
      if (
        Number(old.version) !== version ||
        old.invoice_number !== invoice ||
        old.due_date.toISOString().slice(0, 10) !== due ||
        Number(old.balance_centavos) !== balance ||
        old.source !== b.source
      )
        fail("AR version conflict", "version_conflict", 409);
      continue;
    }
    await c.db`insert into distributor_ar_items(distributor_id,source_key,version,invoice_number,due_date,balance_centavos,source,received_at,effective_from) values(${d.id},${key},${version},${invoice},${due},${balance},${b.source},now(),now()) on conflict(distributor_id,source_key) do update set version=excluded.version,invoice_number=excluded.invoice_number,due_date=excluded.due_date,balance_centavos=excluded.balance_centavos,source=excluded.source,received_at=now(),updated_at=now()`;
  }
  for (const item of list(b.movements ?? [], 500)) {
    const key = text(item.sourceKey),
      day = date(item.date),
      productId = uuid(item.productId),
      qty = integer(item.quantityBase, -1_000_000_000);
    if (
      !["shipment", "return", "transfer", "adjustment"].includes(item.kind) ||
      (item.kind === "shipment" && qty < 0) ||
      (item.kind === "return" && qty > 0)
    )
      fail("Invalid primary movement sign or kind");
    const [known] =
      await c.db`select id from products where id=${productId} and deleted_at is null`;
    if (!known) fail("Unknown product");
    const [old] =
      await c.db`select * from distributor_primary_movements where distributor_id=${d.id} and source_key=${key}`;
    if (old && Number(old.version) >= version) {
      if (
        Number(old.version) !== version ||
        old.product_id !== productId ||
        old.movement_date.toISOString().slice(0, 10) !== day ||
        Number(old.quantity_base) !== qty ||
        old.kind !== item.kind ||
        old.source !== b.source
      )
        fail("Movement version conflict", "version_conflict", 409);
      continue;
    }
    await c.db`insert into distributor_primary_movements(distributor_id,source_key,version,movement_date,product_id,quantity_base,kind,source,received_at) values(${d.id},${key},${version},${day},${productId},${qty},${item.kind},${b.source},now()) on conflict(distributor_id,source_key) do update set version=excluded.version,movement_date=excluded.movement_date,product_id=excluded.product_id,quantity_base=excluded.quantity_base,kind=excluded.kind,source=excluded.source,received_at=now(),updated_at=now()`;
  }
  if (b.complete === true) {
    const from = date(b.from),
      to = date(b.to),
      key = text(b.sourceKey, "SAP feed source key");
    if (
      from > to ||
      to > new Date(c.now + 28800000).toISOString().slice(0, 10) ||
      Date.parse(to) - Date.parse(from) > 365 * 86400000
    )
      fail("Choose a complete SAP feed period of at most 366 past days");
    if (
      (b.movements ?? []).some(
        (/** @type {any} */ r) => date(r.date) < from || date(r.date) > to,
      )
    )
      fail("Primary movements fall outside the declared complete period");
    const hash = digest({
      source: b.source,
      from,
      to,
      movements: b.movements ?? [],
    });
    const [old] =
      await c.db`select * from distributor_primary_feed_receipts where distributor_id=${d.id} and source_key=${key} order by version desc limit 1`;
    if (
      old &&
      (Number(old.version) > version ||
        (Number(old.version) === version && old.payload_hash !== hash))
    )
      fail("SAP feed version conflict", "version_conflict", 409);
    if (!old || Number(old.version) < version)
      await c.db`insert into distributor_primary_feed_receipts(distributor_id,source_key,version,payload_hash,period_from,period_to,source) values(${d.id},${key},${version},${hash},${from},${to},${b.source})`;
  }
  return {
    arItems: (b.arItems ?? []).length,
    movements: (b.movements ?? []).length,
  };
}
