import { sha256Hex } from "../../core/util.js";
import {
  date,
  fail,
  integer,
  list,
  policy,
  text,
  today,
  uuid,
} from "./model.js";
import { enqueueSapPosting } from "./seams.js";
import { bridgeClaim } from "./claim-bridge.js";

const KINDS = [
  "registration",
  "tax",
  "credit",
  "agreement",
  "claim",
  "deposit",
  "circular",
  "price_notice",
  "scheme_notice",
  "statement",
];
/** F-401/F-409/F-414: immutable private bytes; no shared media URL can bypass tenancy.
 * @param {any} c @param {any} d @param {any} b */
export async function uploadDocument(c, d, b) {
  const kind = text(b.kind),
    title = text(b.title),
    version = integer(b.version, 1, 10000);
  if (!KINDS.includes(kind)) fail("Choose a supported document type");
  const office = c.actor.role !== "distributor";
  if (
    !office &&
    !["registration", "tax", "credit", "claim", "deposit"].includes(kind)
  )
    fail("Only Sunpride can publish this kind of document", "forbidden", 403);
  if (
    typeof b.base64 !== "string" ||
    b.base64.length > 800000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      b.base64,
    )
  )
    fail("Upload a PDF, PNG or JPEG below 600 KB");
  const bytes = Buffer.from(b.base64, "base64");
  if (
    !bytes.length ||
    bytes.length > 600000 ||
    bytes.toString("base64") !== b.base64
  )
    fail("Invalid file encoding");
  const pdf = bytes.subarray(0, 5).toString() === "%PDF-",
    png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const mime = pdf
    ? "application/pdf"
    : png
      ? "image/png"
      : jpg
        ? "image/jpeg"
        : null;
  if (!mime) fail("Unsupported file content; use PDF, PNG or JPEG");
  let prior = null;
  if (b.supersedesId) {
    [prior] =
      await c.db`select * from distributor_documents where id=${uuid(b.supersedesId)} and distributor_id=${d.id} and kind=${kind}`;
    if (
      !prior ||
      Number(prior.version) + 1 !== version ||
      prior.title !== title
    )
      fail("Revision must follow the same document's prior version");
    const [next] =
      await c.db`select id from distributor_documents where supersedes_id=${prior.id}`;
    if (next) fail("Document already has a replacement", "conflict", 409);
  } else if (version !== 1) fail("First document version must be 1");
  const hash = sha256Hex(bytes);
  const [row] =
    await c.db`insert into distributor_documents(distributor_id,kind,title,version,content,mime,sha256,uploaded_by,published,supersedes_id) values(${d.id},${kind},${title},${version},${bytes},${mime},${hash},${c.actor.profileId},${office && b.published === true},${prior?.id ?? null}) returning id,title,kind,version,sha256`;
  return row;
}
/** @param {any} c @param {any} d @param {any} b */
export async function acknowledgeDocument(c, d, b) {
  const [doc] =
    await c.db`select * from distributor_documents where id=${uuid(b.documentId)} and distributor_id=${d.id} and published`;
  if (!doc || doc.sha256 !== b.sha256)
    fail("Confirm the exact published document version");
  await c.db`insert into distributor_document_reads(document_id,profile_id,sha256) values(${doc.id},${c.actor.profileId},${doc.sha256}) on conflict(document_id,profile_id) do nothing`;
  return { id: doc.id, version: doc.version, read: true };
}
/** F-409 shared claims intake. SEAM(TPM): F-505 extends this intake via the
 * distributor claim id; do not introduce another claimant object at integration.
 * @param {any} c @param {any} d @param {any} b */
export async function submitClaim(c, d, b) {
  const p = await policy(c, d.id),
    kind = text(b.kind),
    rule = list(p.claimTypes, 20).find((x) => x.kind === kind);
  if (!rule) fail("Claim type needs an active policy");
  const from = date(b.from),
    to = date(b.to);
  if (from > to || to > today(c.now)) fail("Check the claim period");
  const amount = integer(b.amountCentavos, 1),
    number = text(b.claimNumber),
    reason = text(b.reason, "Reason", 2000);
  const evidence = [...new Set(list(b.evidenceIds, 20).map((x) => uuid(x)))];
  if (evidence.length < integer(rule.minimumEvidence, 1, 20))
    fail("Required claim evidence is missing");
  for (const id of evidence) {
    const [doc] =
      await c.db`select id from distributor_documents where id=${id} and distributor_id=${d.id} and kind='claim'`;
    if (!doc)
      fail("Claim evidence is outside this distributor", "out_of_scope", 403);
  }
  if (b.orderId) {
    const [order] =
      await c.db`select id from orders where id=${uuid(b.orderId)} and purchasing_distributor_id=${d.id} and deleted_at is null`;
    if (!order)
      fail("Source order is outside this distributor", "out_of_scope", 403);
  }
  const [old] =
    await c.db`select id from distributor_claims where distributor_id=${d.id} and claim_number=${number}`;
  if (old) fail("Claim reference already submitted", "conflict", 409);
  const [claim] =
    await c.db`insert into distributor_claims(distributor_id,claim_number,kind,period_from,period_to,amount_centavos,reason,source_order_id,campaign_reference,submitted_by) values(${d.id},${number},${kind},${from},${to},${amount},${reason},${b.orderId ?? null},${b.campaignReference ? text(b.campaignReference) : null},${c.actor.profileId}) returning id,status`;
  for (const id of evidence)
    await c.db`insert into distributor_claim_evidence(claim_id,document_id) values(${claim.id},${id})`;
  const [source] =
    await c.db`select * from distributor_claims where id=${claim.id}`;
  await bridgeClaim(c, d, source, evidence);
  return claim;
}
/** @param {any} c @param {any} d @param {any} b */
export async function reviewClaim(c, d, b) {
  const [claim] =
    await c.db`select * from distributor_claims where id=${uuid(b.claimId)} and distributor_id=${d.id}`;
  if (!claim) fail("Claim outside this distributor", "out_of_scope", 403);
  if (claim.submitted_by === c.actor.profileId)
    fail("Another person must review the claim", "self_approval", 403);
  if (
    !["under_review", "evidence_requested", "rejected"].includes(b.status) ||
    claim.status === "rejected"
  )
    fail("Choose a W4 claim intake decision; settlement is owned by TPM");
  text(b.reason, "Review reason", 2000);
  const [shared] =
    await c.db`select status from claims where id=${claim.id} for update`;
  if (shared && ["approved", "part_settled", "settled"].includes(shared.status))
    fail("Finance controls this claim after approval");
  if (b.status === "rejected" && shared)
    await c.db`update claims set status='rejected',updated_at=now() where id=${claim.id}`;
  await c.db`update distributor_claims set status=${b.status},updated_at=now() where id=${claim.id}`;
  await c.db`insert into distributor_events(distributor_id,actor_id,action,entity_id,details) values(${d.id},${c.actor.profileId},'F-409.claim_review',${claim.id},${{ reason: b.reason, status: b.status }})`;
  return { id: claim.id, status: b.status };
}
/** F-415 remittance advice is not cash receipt/posting. @param {any} c @param {any} d @param {any} b */
export async function remit(c, d, b) {
  const ref = text(b.depositReference),
    day = date(b.depositDate),
    amount = integer(b.amountCentavos, 1);
  if (day > today(c.now)) fail("Deposit date cannot be in the future");
  const [doc] =
    await c.db`select id from distributor_documents where id=${uuid(b.evidenceId)} and distributor_id=${d.id} and kind='deposit'`;
  if (!doc)
    fail("Deposit evidence outside this distributor", "out_of_scope", 403);
  const [old] =
    await c.db`select id from distributor_remittances where distributor_id=${d.id} and deposit_reference=${ref}`;
  if (old) fail("Deposit reference already submitted", "conflict", 409);
  const [row] =
    await c.db`insert into distributor_remittances(distributor_id,deposit_reference,deposit_date,amount_centavos,evidence_id,submitted_by) values(${d.id},${ref},${day},${amount},${doc.id},${c.actor.profileId}) returning id,status`;
  return row;
}
/** @param {any} c @param {any} d @param {any} b */
export async function disputeRemittance(c, d, b) {
  const [r] =
    await c.db`select * from distributor_remittances where id=${uuid(b.remittanceId)} and distributor_id=${d.id}`;
  if (!r) fail("Remittance outside this distributor", "out_of_scope", 403);
  if (["sap_pending", "acknowledged"].includes(r.status))
    fail("Sent allocations need SAP reversal; submit a finance case");
  const reason = text(b.reason, "Dispute reason", 2000);
  await c.db`update distributor_remittances set status='disputed',dispute=${reason},updated_at=now() where id=${r.id}`;
  return { id: r.id, status: "disputed" };
}
/** Independent application; source-item version reservations prevent a second allocation
 * against unchanged SAP balances. Acknowledgement NEVER clears the local AR replica.
 * @param {any} c @param {any} d @param {any} b */
export async function matchRemittance(c, d, b) {
  const [r] =
    await c.db`select * from distributor_remittances where id=${uuid(b.remittanceId)} and distributor_id=${d.id} for update`;
  if (!r) fail("Remittance outside this distributor", "out_of_scope", 403);
  if (r.submitted_by === c.actor.profileId)
    fail("Another person must match the deposit", "self_approval", 403);
  if (!["submitted", "matched"].includes(r.status))
    fail("Remittance cannot be allocated at this stage");
  const allocations = [],
    seen = new Set();
  let total = 0;
  for (const a of list(b.allocations, 100)) {
    const id = uuid(a.itemId),
      amount = integer(a.amountCentavos, 1);
    if (seen.has(id)) fail("Combine allocations for the same invoice");
    seen.add(id);
    const [item] =
      await c.db`select * from distributor_ar_items where id=${id} and distributor_id=${d.id}`;
    if (!item) fail("AR invoice outside this distributor", "out_of_scope", 403);
    const reserved =
      await c.db`select allocations from distributor_remittances where distributor_id=${d.id} and id<>${r.id} and status in ('matched','sap_pending','acknowledged')`;
    const used = reserved
      .flatMap((/** @type {any} */ x) => x.allocations)
      .filter(
        (/** @type {any} */ x) =>
          x.itemId === id && x.version === Number(item.version),
      )
      .reduce(
        (/** @type {number} */ n, /** @type {any} */ x) => n + x.amountCentavos,
        0,
      );
    if (amount + used > Number(item.balance_centavos))
      fail("Allocation exceeds the unallocated SAP open item");
    total = integer(total + amount);
    allocations.push({
      itemId: id,
      sourceKey: item.source_key,
      version: Number(item.version),
      amountCentavos: amount,
    });
  }
  if (!total || total > Number(r.amount_centavos))
    fail("Allocation must not exceed the deposit");
  const complete = total === Number(r.amount_centavos);
  const req = complete
    ? await enqueueSapPosting(c, d, "remittance", r.id, {
        depositReference: r.deposit_reference,
        allocations,
      })
    : null;
  const status = complete
    ? req?.status === "acknowledged"
      ? "acknowledged"
      : "sap_pending"
    : "matched";
  await c.db`update distributor_remittances set allocations=${allocations},status=${status},sap_request_id=${req?.id ?? null},updated_at=now() where id=${r.id}`;
  return {
    id: r.id,
    status,
    allocatedCentavos: total,
    unmatchedCentavos: Number(r.amount_centavos) - total,
    sapRequestId: req?.id ?? null,
  };
}
