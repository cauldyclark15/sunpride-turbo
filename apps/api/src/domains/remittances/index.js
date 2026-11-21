import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tx } from "@sunpride/db/client";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError, forbidden, invalid, notFound } from "../../core/errors.js";
import { filesDir } from "../../core/media.js";
import { OpRejected } from "../../core/sync.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { writeAudit } from "../org/audit.js";
import { required, uuid } from "../org/model.js";
import { scopeFilterForActor } from "../org/scope.js";
import { validateCollectionJpeg } from "../masters/photo.js";
import { sellingOn } from "../van/selling.js";
import { CHANNELS, STATUSES } from "./model.js";

/**
 * SP-0228 cash remittance: a salesman who sold away from the depot remits the cash through a
 * remittance center (Palawan, Cebuana, GCash, a bank deposit or another) and records it from the
 * Field app with the receipt photo. Finance confirms or rejects it. Standalone: the weekly truck
 * stock reconciliation (SP-0227) links confirmed remittances later. No amount threshold (client).
 */
export const OP = "remittance.submit";
export { CHANNELS, STATUSES };
const MAX_MINOR = 99_999_999_999;
const DAY = 86_400_000;

/** @param {any} raw */
function receipt(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    raw.mimeType !== "image/jpeg" ||
    typeof raw.bytesBase64 !== "string" ||
    raw.bytesBase64.length > 88000 ||
    typeof raw.sha256 !== "string"
  )
    throw invalid("Take a photo of the remittance receipt");
  const bytes = Buffer.from(raw.bytesBase64, "base64");
  if (
    bytes.toString("base64") !== raw.bytesBase64 ||
    sha256Hex(bytes) !== raw.sha256
  )
    throw invalid("The receipt photo is incomplete. Take it again.");
  validateCollectionJpeg(bytes);
  return { bytes, digest: raw.sha256 };
}

/** @param {any} value @param {string} label @param {number} max */
function optional(value, label, max) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw invalid(`${label} is invalid`);
  const t = value.trim();
  if (!t) return null;
  if (t.length > max) throw invalid(`${label} is too long (up to ${max})`);
  return t;
}

/** Plain validation of the phone's payload. @param {any} p @param {number} now */
export function readRemittance(p, now) {
  if (!p || typeof p !== "object" || Array.isArray(p))
    throw invalid("Enter the remittance details");
  const id = uuid(p.remittanceId, "Remittance");
  const amountMinor = p.amountMinor;
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 1 ||
    amountMinor > MAX_MINOR
  )
    throw invalid("Enter the amount remitted in pesos");
  if (!CHANNELS.includes(p.channel))
    throw invalid("Choose where the cash was remitted");
  const channelOther =
    p.channel === "other"
      ? required(p.channelOther, "Remittance center name", 80)
      : null;
  const referenceNumber = required(p.referenceNumber, "Reference number", 80);
  if (
    !Number.isSafeInteger(p.remittedAt) ||
    p.remittedAt > now + 10 * 60_000 ||
    p.remittedAt < now - 30 * DAY
  )
    throw invalid("Enter when the cash was remitted (within the last 30 days)");
  const note = optional(p.note, "Note", 500);
  return {
    id,
    amountMinor,
    channel: p.channel,
    channelOther,
    referenceNumber,
    remittedAt: p.remittedAt,
    note,
    photo: receipt(p.photo),
  };
}

/** Selling on (or the owner) — the same rule as Truck selling. @param {any} db @param {any} actor */
async function requireSeller(db, actor) {
  await requireCapability({ db, actor }, "remittance.submit");
  if (!actor.profileId || !(await sellingOn(db, actor.profileId)))
    throw forbidden(
      "Only salesmen with Selling turned on can remit cash",
      "not_selling",
    );
  if (!actor.orgUnitId)
    throw forbidden("Your access has no branch", "no_scope");
}

/** @param {any} ctx @param {string} id @param {Buffer} bytes @param {string} digest */
async function storeReceipt(ctx, id, bytes, digest) {
  const relative = `${digest.slice(0, 2)}/${digest}`;
  const folder = join(filesDir(ctx.env), digest.slice(0, 2));
  await mkdir(folder, { recursive: true });
  const temp = join(folder, `${digest}.${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(temp, bytes);
    await rename(temp, join(filesDir(ctx.env), relative));
  } finally {
    await rm(temp, { force: true });
  }
  const [file] =
    await ctx.db`insert into files(owner_id,purpose,sha256,mime,size,path,status,stored_at,device_id,created_by) values(${id},'remittance-receipt',${digest},'image/jpeg',${bytes.length},${relative},'stored',now(),${ctx.device?.id ?? null},${ctx.actor.userId}) on conflict(created_by,purpose,owner_id,sha256) do update set status='stored' returning id`;
  return file.id;
}

/** The push op. Idempotent twice over: the op receipt (clientOpId) and the remittance id.
 * @param {any} ctx */
export async function submitRemittance(ctx) {
  const actor = ctx.actor;
  await requireSeller(ctx.db, actor);
  const r = readRemittance(ctx.payload, ctx.now);
  // The phone stamps deviceTime on each save; the remittance facts alone decide "same record".
  const { deviceTime: _deviceTime, ...facts } = ctx.payload;
  const hash = sha256Hex(canonicalJson(facts));
  const [prior] =
    await ctx.db`select id,payload_hash,salesman_profile_id from field_cash_remittances where id=${r.id} for update`;
  if (prior) {
    if (
      prior.payload_hash !== hash ||
      prior.salesman_profile_id !== actor.profileId
    )
      throw new OpRejected("idempotency_conflict");
    return { entityId: r.id, eventIds: [] };
  }
  const fileId = await storeReceipt(ctx, r.id, r.photo.bytes, r.photo.digest);
  await ctx.db`insert into field_cash_remittances(id,salesman_profile_id,org_unit_id,device_id,payload_hash,amount_minor,channel,channel_other,reference_number,remitted_at,note,photo_file_id)
    values (${r.id},${actor.profileId},${actor.orgUnitId},${ctx.device?.id ?? null},${hash},${r.amountMinor},${r.channel},${r.channelOther},${r.referenceNumber},${new Date(r.remittedAt)},${r.note},${fileId})`;
  await writeAudit(ctx.db, {
    subject: actor.userId,
    action: "remittance.submitted",
    entityType: "field_cash_remittances",
    entityId: r.id,
    details: {
      amountMinor: r.amountMinor,
      channel: r.channel,
      referenceNumber: r.referenceNumber,
    },
  });
  return { entityId: r.id, eventIds: [] };
}

/** @param {any} row */
function dto(row) {
  return {
    id: row.id,
    salesmanProfileId: row.salesman_profile_id,
    salesman: row.salesman_name,
    orgUnitId: row.org_unit_id,
    branch: row.unit_name,
    amountMinor: Number(row.amount_minor),
    channel: row.channel,
    channelOther: row.channel_other,
    referenceNumber: row.reference_number,
    remittedAt: +new Date(row.remitted_at),
    submittedAt: +new Date(row.submitted_at),
    note: row.note,
    status: row.status,
    rejectReason: row.reject_reason,
    reviewedBy: row.reviewer_name ?? null,
    reviewedAt: row.reviewed_at ? +new Date(row.reviewed_at) : null,
  };
}

/** @param {string|null} v @param {string} label */
function day(v, label) {
  if (v == null || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw invalid(`${label} is invalid`);
  return v;
}

/** Finance queue: scoped by the stored branch. Managers see their branch and below; national
 * office roles see all. @param {any} ctx */
export async function listRemittances(ctx) {
  const actor = await requireCapability(ctx, "remittance.read");
  const q = ctx.url.searchParams;
  const from = day(q.get("from"), "From date");
  const to = day(q.get("to"), "To date");
  const unit = q.get("unit") ? uuid(q.get("unit"), "Branch") : null;
  const salesman = q.get("salesman") ? uuid(q.get("salesman"), "Salesman") : null;
  const status = q.get("status") || null;
  if (status && !STATUSES.includes(status)) throw invalid("Status is invalid");
  if (unit) await requireCapability(ctx, "remittance.read", unit);
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  const db = ctx.db;
  const rows = await db`select r.*,p.name salesman_name,u.name unit_name,rv.name reviewer_name
    from field_cash_remittances r
    join profiles p on p.id=r.salesman_profile_id
    join org_units u on u.id=r.org_unit_id
    left join profiles rv on rv.id=r.reviewed_by_profile_id
    where true
    ${unitIds ? db`and r.org_unit_id::text = any(${db.array(unitIds, "TEXT")})` : db``}
    ${unit ? db`and r.org_unit_id=${unit}` : db``}
    ${salesman ? db`and r.salesman_profile_id=${salesman}` : db``}
    ${status ? db`and r.status=${status}` : db``}
    ${from ? db`and r.remitted_at >= (${from}::date::timestamp at time zone 'Asia/Manila')` : db``}
    ${to ? db`and r.remitted_at < ((${to}::date + 1)::timestamp at time zone 'Asia/Manila')` : db``}
    order by r.remitted_at desc, r.id limit 1001`;
  if (rows.length > 1000)
    throw invalid("Too many remittances; narrow the dates", "too_many");
  const items = rows.map(dto);
  const people = new Map(),
    branches = new Map();
  for (const i of items) {
    people.set(i.salesmanProfileId, i.salesman);
    branches.set(i.orgUnitId, i.branch);
  }
  return {
    items,
    salesmen: [...people].map(([id, name]) => ({ id, name })),
    branches: [...branches].map(([id, name]) => ({ id, name })),
    canReview: await canReview(ctx),
  };
}

/** @param {any} ctx */
async function canReview(ctx) {
  try {
    await requireCapability(ctx, "remittance.review");
    return true;
  } catch {
    return false;
  }
}

/** @param {any} ctx @param {string} id @param {string} capability @param {boolean} [lock] */
async function scopedRow(ctx, id, capability, lock = false) {
  await requireCapability(ctx, capability);
  const [row] = lock
    ? await ctx.db`select * from field_cash_remittances where id=${uuid(id, "Remittance")} for update`
    : await ctx.db`select * from field_cash_remittances where id=${uuid(id, "Remittance")}`;
  if (!row) throw notFound("Remittance not found");
  try {
    await requireCapability(ctx, capability, row.org_unit_id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403)
      throw notFound("Remittance not found");
    throw e;
  }
  return row;
}

/** @param {any} ctx */
export async function receiptPhoto(ctx) {
  let row;
  try {
    row = await scopedRow(ctx, ctx.params.id, "remittance.read");
  } catch (e) {
    // The salesman may always open their own receipt.
    const [own] =
      ctx.actor?.profileId && e instanceof ApiError && e.status !== 401
        ? await ctx.db`select * from field_cash_remittances where id=${uuid(ctx.params.id, "Remittance")} and salesman_profile_id=${ctx.actor.profileId}`
        : [];
    if (!own) throw e;
    row = own;
  }
  const [file] =
    await ctx.db`select path,sha256 from files where id=${row.photo_file_id} and status='stored'`;
  if (!file || file.path !== `${file.sha256.slice(0, 2)}/${file.sha256}`)
    throw notFound("Receipt photo not found");
  const blob = Bun.file(join(filesDir(ctx.env), file.path));
  if (!(await blob.exists())) throw notFound("Receipt photo not found");
  return new Response(blob, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Confirm or reject once; a repeat of the same decision is a no-op, a different one is refused.
 * @param {any} ctx @param {"confirmed"|"rejected"} decision */
export async function reviewRemittance(ctx, decision) {
  return tx(ctx.db, async (db) => {
    const c = { ...ctx, db };
    const row = await scopedRow(c, ctx.params.id, "remittance.review", true);
    const actor = c.actor;
    if (row.salesman_profile_id === actor.profileId)
      throw forbidden("You cannot review your own remittance");
    const reason =
      decision === "rejected"
        ? required(ctx.body?.reason, "Reason for rejecting", 500)
        : null;
    if (row.status !== "submitted") {
      if (
        row.status === decision &&
        (decision === "confirmed" || row.reject_reason === reason)
      )
        return { id: row.id, status: row.status };
      throw invalid(
        `This remittance was already ${row.status}`,
        "already_reviewed",
      );
    }
    await db`update field_cash_remittances set status=${decision},reject_reason=${reason},reviewed_by_profile_id=${actor.profileId},reviewed_at=now(),updated_at=now() where id=${row.id}`;
    await writeAudit(db, {
      subject: actor.userId,
      action: `remittance.${decision}`,
      entityType: "field_cash_remittances",
      entityId: row.id,
      details: reason ? { reason } : null,
    });
    return { id: row.id, status: decision };
  });
}

/** @param {any} router @param {any} platform */
export function install(router, platform) {
  platform.registerOp(OP, async (/** @type {any} */ ctx) => {
    try {
      return await submitRemittance({ ...ctx, env: platform.env });
    } catch (e) {
      if (e instanceof ApiError)
        throw new OpRejected(
          e.status === 403 && e.code !== "not_selling"
            ? "out_of_scope"
            : "invalid_request",
        );
      throw e;
    }
  });
  router.get("/api/v1/remittances", (/** @type {any} */ c) =>
    listRemittances(c),
  );
  router.get("/api/v1/remittances/:id/receipt", (/** @type {any} */ c) =>
    receiptPhoto(c),
  );
  for (const [path, decision] of /** @type {const} */ ([
    ["confirm", "confirmed"],
    ["reject", "rejected"],
  ]))
    router.post(
      `/api/v1/remittances/:id/${path}`,
      async (/** @type {any} */ c) => {
        return reviewRemittance(c, decision);
      },
    );
}
