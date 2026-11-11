import { requireCapability } from "../../core/capabilities.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { currentActor, currentDeviceActor } from "../van/access.js";
import { integer, uuid, text, choice, refuse } from "../van/model.js";
import { loadPrintModel } from "./print-model.js";

export const DOCUMENT_TYPES = [
  "sales_invoice",
  "official_receipt",
  "credit_memo",
  "delivery_receipt",
];
/** F-018: live authorization cannot be manufactured by a sample registration.
 * @param {any} db @param {any} registration @param {string|null} deviceId @param {number} at */
export async function issuanceGate(db, registration, deviceId, at) {
  const r = registration;
  if (
    !r ||
    new Date(r.effective_from).getTime() > at ||
    (r.effective_to && new Date(r.effective_to).getTime() <= at) ||
    (r.device_id && r.device_id !== deviceId)
  )
    refuse("Fiscal authorization is missing or expired");
  if (r.sample && r.status === "sample_not_filed") {
    const [sample] =
      await db`select 1 from sample_data_rows where table_name='org_units' and row_id=${r.org_unit_id} limit 1`;
    if (!sample) refuse("Sample documents require a marked sample branch");
    return;
  }
  if (
    r.status !== "approved" ||
    !r.verified_by ||
    r.verified_by === r.entered_by ||
    !r.permit_reference ||
    !r.evidence_reference
  )
    refuse("BIR authorization must be independently verified before issuing");
}
/** F-018. @param {any} db @param {any} actor @param {any} p */
export async function saveRegistration(db, actor, p) {
  actor = await currentActor(db, actor);
  await requireCapability({ db, actor }, "admin.manage", uuid(p.orgUnitId));
  const status = choice(p.status, [
    "sample_not_filed",
    "draft",
    "filed",
    "acknowledged",
    "approved",
    "suspended",
    "expired",
  ]);
  const from = instant(p.effectiveFrom);
  let to = p.effectiveTo ? instant(p.effectiveTo) : null;
  if (to && to <= from) refuse("End must follow the start");
  const id = p.id ? uuid(p.id) : crypto.randomUUID();
  const [prior] =
    await db`select * from fiscal_registrations where id=${id} for update`;
  if (prior && prior.org_unit_id !== p.orgUnitId)
    refuse("A registration cannot change branch");
  // An ordinary filing-status edit must never silently turn an expiring permit into an unlimited one.
  if (prior && !p.effectiveTo)
    to = prior.effective_to ? new Date(prior.effective_to) : null;
  const enteredBy = prior?.entered_by ?? actor.profileId;
  const taxBasisPoints =
    p.taxBasisPoints === undefined
      ? (prior?.tax_basis_points ??
        (status === "sample_not_filed" ? 1200 : null))
      : Number(p.taxBasisPoints);
  if (
    !Number.isSafeInteger(taxBasisPoints) ||
    taxBasisPoints < 0 ||
    taxBasisPoints > 10000
  )
    refuse("Configure an explicit inclusive VAT rate in basis points");
  if (prior && prior.tax_basis_points !== taxBasisPoints)
    refuse(
      "Create a new effective-dated registration for a different tax treatment",
    );
  const deviceId =
    p.deviceId === undefined ? (prior?.device_id ?? null) : p.deviceId || null;
  if (
    prior &&
    (prior.device_id !== deviceId ||
      prior.document_type !== p.documentType ||
      new Date(prior.effective_from).getTime() !== from.getTime())
  )
    refuse(
      "Create a new effective-dated registration for different applicability",
    );
  if (deviceId) {
    const [device] =
      await db`select org_unit_id,status from registered_devices where id=${uuid(deviceId)} for share`;
    if (
      !device ||
      device.org_unit_id !== p.orgUnitId ||
      device.status !== "active"
    )
      refuse("Choose an active handheld from the same branch");
  }
  if (
    status === "approved" &&
    (enteredBy === actor.profileId ||
      !text(p.permitReference, 150, true) ||
      !text(p.evidenceReference, 500, true))
  )
    refuse("A second administrator must verify the permit and evidence");
  if (status === "sample_not_filed") {
    const [sample] =
      await db`select 1 from sample_data_rows where table_name='org_units' and row_id=${p.orgUnitId} limit 1`;
    if (!sample) refuse("Choose a marked sample branch");
  }
  if (prior?.sample && status !== "sample_not_filed")
    refuse("Sample registration cannot become a live permit");
  await db`insert into fiscal_registrations(id,org_unit_id,entity_name,branch_name,tin,address,device_id,document_type,status,application_reference,permit_reference,evidence_reference,filed_at,acknowledged_at,effective_from,effective_to,entered_by,verified_by,sample,tax_basis_points)
   values(${id},${p.orgUnitId},${text(p.entityName, 200, true)},${text(p.branchName, 150, true)},${text(p.tin, 50, true)},${text(p.address, 400, true)},${deviceId},${choice(p.documentType, DOCUMENT_TYPES)},${status},${text(p.applicationReference, 150)},${text(p.permitReference, 150)},${text(p.evidenceReference, 500)},${p.filedAt ? instant(p.filedAt) : (prior?.filed_at ?? null)},${p.acknowledgedAt ? instant(p.acknowledgedAt) : (prior?.acknowledged_at ?? null)},${from},${to},${enteredBy},${status === "approved" ? actor.profileId : null},${status === "sample_not_filed"},${taxBasisPoints})
   on conflict(id) do update set entity_name=excluded.entity_name,branch_name=excluded.branch_name,tin=excluded.tin,address=excluded.address,status=excluded.status,application_reference=excluded.application_reference,permit_reference=excluded.permit_reference,evidence_reference=excluded.evidence_reference,filed_at=excluded.filed_at,acknowledged_at=excluded.acknowledged_at,effective_to=excluded.effective_to,verified_by=excluded.verified_by,updated_at=now()`;
  return { id };
}
/** @param {any} value */
export function instant(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    refuse("Use a valid date and time");
  return new Date(value);
}
/** F-019. Approved ranges are immutable; extend by a new nonoverlapping series prefix.
 * @param {any} db @param {any} actor @param {any} p */
export async function createSeries(db, actor, p) {
  actor = await currentActor(db, actor);
  const [r] =
    await db`select * from fiscal_registrations where id=${uuid(p.registrationId)} for share`;
  if (!r) refuse("Choose a registration");
  await requireCapability({ db, actor }, "admin.manage", r.org_unit_id);
  const first = integer(p.firstSerial, true),
    last = integer(p.lastSerial, true);
  if (last < first || last > 999999999n)
    refuse("Choose a valid serial range up to nine digits");
  const prefix = text(p.prefix, 50, true);
  if (!/^[A-Z0-9-]+$/.test(prefix ?? ""))
    refuse("Use capital letters, digits and hyphens for a series");
  if (p.vehicleId) {
    const [v] =
      await db`select org_unit_id from vehicles where id=${uuid(p.vehicleId)} and deleted_at is null`;
    if (!v || v.org_unit_id !== r.org_unit_id)
      refuse("Vehicle must belong to the registered branch");
  }
  // NF-2: handhelds number from the most specific series (register, van, branch); two live ones at one
  // level for the same document type leave the phone unable to choose, so the office cannot create that tie.
  const from = instant(p.effectiveFrom),
    to = p.effectiveTo ? instant(p.effectiveTo) : null;
  const [tie] =
    await db`select s.prefix from fiscal_series s join fiscal_registrations o on o.id=s.registration_id
      where o.org_unit_id=${r.org_unit_id} and o.document_type=${r.document_type}
      and o.device_id is not distinct from ${r.device_id} and s.vehicle_id is not distinct from ${p.vehicleId ?? null}
      and s.next_allocate<=s.last_serial and (s.effective_to is null or s.effective_to>${from})
      and (${to}::timestamptz is null or s.effective_from<${to}) limit 1`;
  if (tie)
    refuse(
      `Series ${tie.prefix} already numbers these ${String(r.document_type).replace("_", " ")}s at this level; end it first or bind the new series to a van or register`,
    );
  const [s] =
    await db`insert into fiscal_series(registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from,effective_to)
   values(${r.id},${p.vehicleId ?? null},${prefix},${String(first)},${String(last)},${String(first)},${instant(p.effectiveFrom)},${p.effectiveTo ? instant(p.effectiveTo) : null}) returning id`;
  return { id: s.id };
}
/** F-019 seam. Caller owns transaction. No range is ever returned to the pool.
 * @param {any} db @param {{actor:any,deviceId:string,seriesId:string,requestKey:string,count:number}} input */
export async function allocateDocumentNumber(db, input) {
  const { actor, device } = await currentDeviceActor(
    db,
    input.actor,
    uuid(input.deviceId),
  );
  const [s] =
    await db`select * from fiscal_series where id=${uuid(input.seriesId)} for update`;
  if (!s) refuse("Document series needs setup");
  const [r] =
    await db`select * from fiscal_registrations where id=${s.registration_id} for share`;
  await requireCapability({ db, actor }, "van.operate", r.org_unit_id);
  await issuanceGate(db, r, device.id, Date.now());
  if (s.vehicle_id) {
    const [trip] =
      await db`select id from van_trips where vehicle_id=${s.vehicle_id} and salesperson_profile_id=${actor.profileId} and status not in ('closed','cancelled') and deleted_at is null`;
    if (!trip) refuse("Series belongs to another van");
  }
  if (
    new Date(s.effective_from).getTime() > Date.now() ||
    (s.effective_to && new Date(s.effective_to).getTime() <= Date.now())
  )
    refuse("Series is not effective");
  const key = uuid(input.requestKey),
    count = input.count;
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
    refuse("Allocate between 1 and 1000 numbers");
  const [prior] =
    await db`select * from fiscal_allocations where device_id=${device.id} and request_key=${key}`;
  if (prior) {
    if (
      prior.series_id !== s.id ||
      Number(prior.last_serial) - Number(prior.first_serial) + 1 !== count ||
      prior.profile_id !== actor.profileId
    )
      refuse("Allocation key was reused");
    return allocationDto(prior, s, r);
  }
  const first = BigInt(s.next_allocate),
    last = first + BigInt(count) - 1n;
  if (last > BigInt(s.last_serial))
    refuse("Series is exhausted; allocate a new approved series");
  const [a] =
    await db`insert into fiscal_allocations(series_id,device_id,profile_id,request_key,first_serial,last_serial,next_issue,registration_snapshot)
   values(${s.id},${device.id},${actor.profileId},${key},${String(first)},${String(last)},${String(first)},${registrationSnapshot(r)}) returning *`;
  await db`update fiscal_series set next_allocate=${String(last + 1n)},updated_at=now() where id=${s.id}`;
  return allocationDto(a, s, r);
}
/** @param {any} r */
export const registrationSnapshot = (r) => ({
  entityName: r.entity_name,
  branchName: r.branch_name,
  tin: r.tin,
  address: r.address,
  permitReference: r.permit_reference,
  sample: r.sample,
  status: r.status,
  taxBasisPoints: r.tax_basis_points,
});
/** @param {any} a @param {any} s @param {any} r */
export const allocationDto = (a, s, r) => ({
  allocationId: a.id,
  seriesId: s.id,
  documentType: r.document_type,
  prefix: s.prefix,
  firstSerial: String(a.first_serial),
  lastSerial: String(a.last_serial),
  nextSerial: String(a.next_issue),
  deviceId: a.device_id,
  registration:
    a.registration_snapshot ??
    refuse(
      "Legacy allocation lacks frozen registration; reconcile it before issuing",
    ),
  effectiveTo: r.effective_to ? new Date(r.effective_to).getTime() : null,
});
/** F-019/F-108: called inside the sale/collection transaction with SERVER-validated frozen facts.
 * @param {any} db @param {any} input */
export async function issueDocument(db, input) {
  const { actor } = await currentDeviceActor(
    db,
    input.actor,
    uuid(input.deviceId),
  );
  const [a] =
    await db`select * from fiscal_allocations where id=${uuid(input.allocationId)} for update`;
  if (!a || a.device_id !== input.deviceId || a.profile_id !== actor.profileId)
    refuse("Fiscal range is not allocated to this handheld");
  if (
    (
      await db`select 1 from fiscal_allocation_closures where allocation_id=${a.id}`
    ).length
  )
    refuse(
      "This document range was permanently retired; reconcile saved work with the office",
    );
  const [s] =
    await db`select * from fiscal_series where id=${a.series_id} for share`;
  const [r] =
    await db`select * from fiscal_registrations where id=${s.registration_id} for share`;
  await requireCapability({ db, actor }, "van.operate", r.org_unit_id);
  if (s.vehicle_id && input.vehicleId !== s.vehicle_id)
    refuse("Series belongs to another van");
  await issuanceGate(db, r, input.deviceId, Date.now());
  await issuanceGate(db, r, input.deviceId, input.at);
  if (
    r.document_type !== input.documentType ||
    new Date(s.effective_from).getTime() > input.at ||
    (s.effective_to && new Date(s.effective_to).getTime() <= input.at)
  )
    refuse("Document type or series validity does not match");
  const serial = integer(input.serial, true),
    sourceId = uuid(input.sourceId);
  const number = `${s.prefix}-${String(serial).padStart(9, "0")}`;
  const snapshot = {
    ...input.snapshot,
    documentType: r.document_type,
    documentNumber: number,
    registration: allocationDto(a, s, r).registration,
  };
  const hash = sha256Hex(canonicalJson(snapshot));
  const [prior] =
    await db`select * from fiscal_documents where source_type=${input.sourceType} and source_id=${sourceId}`;
  if (prior) {
    if (
      prior.snapshot_hash !== hash ||
      prior.serial.toString() !== String(serial) ||
      prior.allocation_id !== a.id
    )
      refuse("Fiscal document facts changed");
    return prior;
  }
  if (serial !== BigInt(a.next_issue) || serial > BigInt(a.last_serial))
    refuse("Issue the next reserved number; gaps must be recorded as spoiled");
  const [d] =
    await db`insert into fiscal_documents(allocation_id,series_id,serial,document_number,source_type,source_id,snapshot,snapshot_hash,issued_at)
   values(${a.id},${s.id},${String(serial)},${number},${text(input.sourceType, 80, true)},${sourceId},${snapshot},${hash},${new Date(input.at)}) returning *`;
  await db`update fiscal_allocations set next_issue=${String(serial + 1n)},updated_at=now() where id=${a.id}`;
  await db`insert into fiscal_document_events(document_id,kind,request_key,reason,actor_profile_id) values(${d.id},'issued',${sourceId},'Issued with immutable transaction facts',${actor.profileId})`;
  await recordDocumentTax(db, d, r, snapshot);
  return d;
}
/** IP-BIR: typed per-document tax row for Z readings and the tax summary. Buckets are before the privilege discount.
 * @param {any} db @param {any} d @param {any} r @param {any} snapshot */
async function recordDocumentTax(db, d, r, snapshot) {
  const t = snapshot.tax;
  if (
    !t ||
    typeof t !== "object" ||
    !["store_sale", "van_sale"].includes(d.source_type)
  )
    return;
  const n = (/** @type {any} */ v) =>
    /^\d{1,15}$/.test(String(v ?? "")) ? String(v) : null;
  const vatable = n(t.vatableSalesMinor),
    vat = n(t.vatMinor),
    exempt = n(t.vatExemptMinor),
    zero = n(t.zeroRatedMinor),
    total = n(t.totalMinor);
  if (
    vatable === null ||
    vat === null ||
    exempt === null ||
    zero === null ||
    total === null
  )
    return;
  const priv = n(t.privilegeDiscountMinor) ?? "0",
    removed = n(t.vatRemovedMinor) ?? "0";
  await db`insert into fiscal_document_tax(document_id,org_unit_id,source_type,document_type,issued_at,business_date,gross_centavos,vatable_centavos,vat_centavos,vat_exempt_centavos,zero_rated_centavos,promo_discount_centavos,privilege_discount_centavos,vat_removed_centavos,privilege_type,total_due_centavos)
    values(${d.id},${r.org_unit_id},${d.source_type},${r.document_type},${d.issued_at},${manilaDay(d.issued_at)},${n(t.grossMinor) ?? total},${vatable},${vat},${exempt},${zero},${n(t.promoDiscountMinor) ?? "0"},${priv},${removed},${BigInt(priv) > 0n || BigInt(removed) > 0n ? (t.privilegeType ?? null) : null},${total})
    on conflict(document_id) do nothing`;
}
/** @param {any} at */
const manilaDay = (at) =>
  new Date(new Date(at).getTime() + 8 * 3600000).toISOString().slice(0, 10);
/** F-019/F-109. No document may be deleted or assigned a new number.
 * @param {any} db @param {any} actor @param {any} p */
export async function documentEvent(db, actor, p) {
  actor = await currentActor(db, actor);
  const [d] =
    await db`select d.*,r.org_unit_id,a.profile_id from fiscal_documents d join fiscal_allocations a on a.id=d.allocation_id join fiscal_series s on s.id=d.series_id join fiscal_registrations r on r.id=s.registration_id where d.id=${uuid(p.documentId)} for update of d`;
  if (!d) refuse("Document not found");
  await requireCapability({ db, actor }, "van.operate", d.org_unit_id);
  if (actor.role === "sales" && d.profile_id !== actor.profileId)
    refuse("This document belongs to another seller");
  const kind = choice(p.kind, ["print", "reprint", "void", "spoiled"]),
    reason = text(p.reason, 300, true),
    key = uuid(p.requestKey);
  const [prior] =
    await db`select * from fiscal_document_events where document_id=${d.id} and request_key=${key}`;
  if (prior) {
    if (prior.kind !== kind || prior.reason !== reason)
      refuse("Print or void key changed");
    return { id: prior.id };
  }
  if (kind === "void" || kind === "spoiled")
    refuse("Void requires the controlled transaction override path");
  // IP-BIR: the e-journal trigger records this hash of the exact receipt content that was (re)printed.
  const [{ n: sameKind }] =
    await db`select count(*)::int as n from fiscal_document_events where document_id=${d.id} and kind=${kind}`;
  const { model } = await loadPrintModel(db, d.id, {
    copy:
      kind === "reprint"
        ? { kind: "reprint", number: sameKind + 1 }
        : undefined,
  });
  await db`select set_config('sunpride.ejournal_model_hash',${model.contentHash},true)`;
  const [event] =
    await db`insert into fiscal_document_events(document_id,kind,request_key,reason,actor_profile_id,facts) values(${d.id},${kind},${key},${reason},${actor.profileId},${{ copy: kind === "reprint" ? "REPRINT" : "ORIGINAL", outcome: choice(p.outcome, ["printed", "not_printed", "uncertain"]), printId: p.printId ? uuid(p.printId) : null }}) returning id`;
  await db`select set_config('sunpride.ejournal_model_hash','',true)`;
  return { id: event.id };
}
