import { canonicalJson, sha256Hex } from "../../core/util.js";
import { conflict, invalid } from "../../core/errors.js";
import { writeAudit } from "../org/audit.js";
import {
  ORGANIZATION,
  uuid,
  text,
  product,
  accessOutlet,
  ownedVisit,
  validTime,
  reject,
  event,
  changed,
  touchVisit,
  ms,
} from "./shared.js";

export const AUDIT_VERSION = "merchandising-audit/2026-10-04";
/** @param {any} db @param {string} outletId @param {number} at */
export async function assortmentAt(db, outletId, at) {
  const [row] =
    await db`select a.*,coalesce((select jsonb_agg(p.product_id order by p.ordinal) from outlet_assortment_products p
    where p.outlet_assortment_id=a.id and p.deleted_at is null),'[]'::jsonb) as product_ids
    from outlet_assortments a where a.outlet_id=${uuid(outletId)} and a.deleted_at is null and a.effective_from<=${new Date(at)}
    and (a.effective_to is null or a.effective_to>${new Date(at)})`;
  return row
    ? {
        assortmentId: row.id,
        productIds: row.product_ids,
        effectiveFrom: ms(row.effective_from),
        effectiveTo: row.effective_to ? ms(row.effective_to) : null,
        sourceRef: row.source_ref,
      }
    : null;
}
/** @param {any} ctx */
export async function setAssortment(ctx) {
  const p = ctx.body;
  await accessOutlet(ctx, uuid(p.outletId), "outlet.manage");
  if (
    !Number.isSafeInteger(p.effectiveFrom) ||
    p.effectiveFrom <= ctx.now ||
    !Array.isArray(p.productIds) ||
    p.productIds.length > 200 ||
    new Set(p.productIds).size !== p.productIds.length
  )
    throw invalid();
  const source = text(p.sourceRef);
  for (const id of p.productIds) await product(ctx.db, id);
  await ctx.db`select pg_advisory_xact_lock(hashtext(${`assortment:${p.outletId}`}))`;
  const future =
    await ctx.db`select 1 from outlet_assortments where outlet_id=${p.outletId} and effective_from>=${new Date(p.effectiveFrom)} and deleted_at is null`;
  if (future.length) throw conflict("A later assortment is already scheduled");
  await ctx.db`update outlet_assortments set effective_to=${new Date(p.effectiveFrom)} where outlet_id=${p.outletId} and deleted_at is null
    and effective_from<${new Date(p.effectiveFrom)} and (effective_to is null or effective_to>${new Date(p.effectiveFrom)})`;
  const [row] =
    await ctx.db`insert into outlet_assortments (organization_id,outlet_id,effective_from,source_ref,actor_subject)
    values (${ORGANIZATION},${p.outletId},${new Date(p.effectiveFrom)},${source},${ctx.actor.subject}) returning id`;
  for (const [ordinal, id] of p.productIds.entries())
    await ctx.db`insert into outlet_assortment_products (outlet_assortment_id,ordinal,product_id) values (${row.id},${ordinal},${id})`;
  await writeAudit(ctx.db, {
    subject: ctx.actor.subject,
    action: "assortment.set",
    entityType: "outlet_assortments",
    entityId: row.id,
    details: null,
  });
  const { owner } = await accessOutlet(ctx, p.outletId, "outlet.manage");
  await ctx.change("assortment", row.id, owner);
  ctx.publish("visits");
  return { id: row.id };
}
/** @param {any} ids */
function photos(ids = []) {
  if (
    !Array.isArray(ids) ||
    ids.length > 20 ||
    new Set(ids).size !== ids.length
  )
    reject();
  return ids.map(uuid);
}
/** @param {any} value @param {number} [max] */
const optionalText = (value, max = 500) =>
  value === undefined ? null : text(value, max);
/** @param {any} ctx */
export async function recordAudit(ctx) {
  const p = ctx.payload ?? ctx.body;
  uuid(p.clientAuditId);
  validTime(p.deviceTime, ctx.now);
  const visit = await ownedVisit(ctx, p.visitId, true);
  const av = p.availability,
    co = p.compliance,
    ce = p.competitors;
  if (
    !Array.isArray(av) ||
    !Array.isArray(co) ||
    !Array.isArray(ce) ||
    av.length > 200 ||
    co.length > 50 ||
    ce.length > 50 ||
    av.length + co.length + ce.length === 0 ||
    new Set(av.map((l) => l.productId)).size !== av.length
  )
    reject();
  const evidenceIds = photos(p.evidenceIds);
  const availability = av.map((l) => {
    uuid(l.productId);
    if (
      !["available", "low_stock", "out_of_stock", "not_carried"].includes(
        l.status,
      ) ||
      (l.facings !== undefined &&
        (!Number.isSafeInteger(l.facings) ||
          l.facings < 0 ||
          l.facings > 10000 ||
          (l.facings > 0 &&
            ["out_of_stock", "not_carried"].includes(l.status))))
    )
      reject();
    return {
      productId: l.productId,
      status: l.status,
      facings: l.facings ?? null,
      note: optionalText(l.note),
      evidenceIds: photos(l.evidenceIds),
    };
  });
  const compliance = co.map((c) => {
    if (
      ![
        "display",
        "price_tag",
        "promotion",
        "freezer_placement",
        "shelf_share",
        "product_freshness",
      ].includes(c.kind) ||
      !["compliant", "non_compliant", "not_present", "not_applicable"].includes(
        c.finding,
      ) ||
      (c.shareOfShelfPercent !== undefined &&
        (c.kind !== "shelf_share" ||
          !Number.isInteger(c.shareOfShelfPercent) ||
          c.shareOfShelfPercent < 0 ||
          c.shareOfShelfPercent > 100))
    )
      reject();
    return {
      kind: c.kind,
      finding: c.finding,
      programRef:
        c.kind === "promotion"
          ? text(c.programRef)
          : optionalText(c.programRef, 200),
      shareOfShelfPercent: c.shareOfShelfPercent ?? null,
      actionTaken: optionalText(c.actionTaken),
      evidenceIds: photos(c.evidenceIds),
    };
  });
  const competitors = ce.map((c) => {
    const priced = c.observedPriceMinor !== undefined;
    if (
      ![
        "price",
        "promotion",
        "display",
        "new_product",
        "stock_level",
        "other",
      ].includes(c.kind) ||
      priced !== (c.currency !== undefined) ||
      (c.kind === "price" && !priced) ||
      (priced &&
        (!Number.isSafeInteger(c.observedPriceMinor) ||
          c.observedPriceMinor < 0 ||
          !/^[A-Z]{3}$/.test(c.currency)))
    )
      reject();
    return {
      kind: c.kind,
      brand: text(c.brand, 100),
      productCategory: optionalText(c.productCategory, 100),
      observedPriceMinor: c.observedPriceMinor ?? null,
      currency: c.currency ?? null,
      note: optionalText(c.note),
      evidenceIds: photos(c.evidenceIds),
    };
  });
  const hash = sha256Hex(
    canonicalJson({
      visitId: visit.id,
      deviceTime: p.deviceTime,
      availability,
      compliance,
      competitors,
      evidenceIds,
    }),
  );
  const [replay] =
    await ctx.db`select * from merchandising_audits where organization_id=${ORGANIZATION} and client_audit_id=${p.clientAuditId}`;
  if (replay) {
    if (
      replay.payload_hash !== hash ||
      replay.visit_id !== visit.id ||
      replay.assignee_profile_id !== ctx.actor.profileId
    )
      reject("idempotency_conflict");
    return { entityId: replay.id, eventIds: [] };
  }
  if (!["checked-in", "in-progress"].includes(visit.state))
    reject("invalid_transition");
  const existing =
    await ctx.db`select 1 from merchandising_audits where visit_id=${visit.id}`;
  if (existing.length) reject("idempotency_conflict");
  for (const line of availability) await product(ctx.db, line.productId);
  const linked = new Set([
    ...evidenceIds,
    ...availability.flatMap((l) => l.evidenceIds),
    ...compliance.flatMap((l) => l.evidenceIds),
    ...competitors.flatMap((l) => l.evidenceIds),
  ]);
  if (linked.size > 100) reject();
  for (const id of linked) {
    const rows =
      await ctx.db`select 1 from field_evidence_files where id=${id} and visit_id=${visit.id} and owner_profile_id=${ctx.actor.profileId} and status<>'rejected' and deleted_at is null`;
    if (!rows.length) reject("evidence_pending_review");
  }
  const assortment = await assortmentAt(ctx.db, visit.outlet_id, ctx.now);
  const required = new Set(assortment?.productIds ?? []);
  const available = availability.filter(
    (l) =>
      required.has(l.productId) &&
      ["available", "low_stock"].includes(l.status),
  ).length;
  const out = availability.filter(
    (l) => required.has(l.productId) && l.status === "out_of_stock",
  ).length;
  const missing = [...required].filter(
    (id) => !availability.some((l) => l.productId === id),
  );
  const [row] =
    await ctx.db`insert into merchandising_audits (organization_id,org_unit_id,visit_id,outlet_id,assignee_profile_id,service_date,client_audit_id,payload_hash,audit_version,assortment_id,required_count,required_available_count,required_out_of_stock_count,actor_subject,source,device_time,server_time)
    values (${ORGANIZATION},${visit.org_unit_id},${visit.id},${visit.outlet_id},${ctx.actor.profileId},${new Date(visit.service_date).toISOString().slice(0, 10)},${p.clientAuditId},${hash},${AUDIT_VERSION},${assortment?.assortmentId ?? null},${required.size},${available},${out},${ctx.actor.subject},${ctx.device ? "mobile" : "web"},${new Date(p.deviceTime)},${new Date(ctx.now)}) returning id`;
  for (const [ordinal, id] of missing.entries())
    await ctx.db`insert into merchandising_audit_missing_products (merchandising_audit_id,ordinal,product_id) values (${row.id},${ordinal},${id})`;
  await linkPhotos(
    ctx.db,
    "merchandising_audit_evidence",
    "merchandising_audit_id",
    row.id,
    evidenceIds,
  );
  for (const l of availability) {
    const [child] =
      await ctx.db`insert into merchandising_availability (organization_id,org_unit_id,audit_id,outlet_id,product_id,service_date,required,status,facings,note)
      values (${ORGANIZATION},${visit.org_unit_id},${row.id},${visit.outlet_id},${l.productId},${new Date(visit.service_date).toISOString().slice(0, 10)},${required.has(l.productId)},${l.status},${l.facings},${l.note}) returning id`;
    await linkPhotos(
      ctx.db,
      "merchandising_availability_evidence",
      "merchandising_availability_id",
      child.id,
      l.evidenceIds,
    );
  }
  for (const c of compliance) {
    const [child] =
      await ctx.db`insert into merchandising_compliance_checks (organization_id,org_unit_id,audit_id,outlet_id,service_date,kind,finding,program_ref,share_of_shelf_percent,action_taken)
      values (${ORGANIZATION},${visit.org_unit_id},${row.id},${visit.outlet_id},${new Date(visit.service_date).toISOString().slice(0, 10)},${c.kind},${c.finding},${c.programRef},${c.shareOfShelfPercent},${c.actionTaken}) returning id`;
    await linkPhotos(
      ctx.db,
      "merchandising_compliance_check_evidence",
      "merchandising_compliance_check_id",
      child.id,
      c.evidenceIds,
    );
  }
  for (const c of competitors) {
    const [child] =
      await ctx.db`insert into competitor_observations (organization_id,org_unit_id,audit_id,outlet_id,service_date,kind,brand,product_category,observed_price_minor,currency,note)
      values (${ORGANIZATION},${visit.org_unit_id},${row.id},${visit.outlet_id},${new Date(visit.service_date).toISOString().slice(0, 10)},${c.kind},${c.brand},${c.productCategory},${c.observedPriceMinor},${c.currency},${c.note}) returning id`;
    await linkPhotos(
      ctx.db,
      "competitor_observation_evidence",
      "competitor_observation_id",
      child.id,
      c.evidenceIds,
    );
  }
  await ctx.db`update visit_executions set state='in-progress' where id=${visit.id}`;
  await touchVisit(ctx, visit);
  const eventId = await event(
    ctx,
    visit,
    "visit",
    visit.id,
    "merchandising.audit_recorded",
    { after: "recorded" },
  );
  await ctx.change("merchandisingAudit", row.id, visit.org_unit_id);
  await changed(ctx, visit);
  return { entityId: row.id, eventIds: [eventId] };
}
/** Identifiers are internal fixed constants, never caller values. @param {any} db @param {string} table @param {string} fk @param {string} id @param {string[]} ids */
async function linkPhotos(db, table, fk, id, ids) {
  const allowed = [
    "merchandising_audit_evidence",
    "merchandising_availability_evidence",
    "merchandising_compliance_check_evidence",
    "competitor_observation_evidence",
  ];
  if (!allowed.includes(table)) throw new Error("Invalid evidence table");
  for (const [ordinal, fileId] of ids.entries())
    await db.unsafe(
      `insert into ${table} (${fk},ordinal,evidence_file_id) values ($1,$2,$3)`,
      [id, ordinal, fileId],
    );
}
