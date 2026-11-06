import { nextDocNumber } from "../../core/docnum.js";
import { uuid, refuse, text, choice, integer } from "../van/model.js";
import { ApiError } from "../../core/errors.js";
import { requireReason, listReasonCodes } from "../inventory/reasons.js";
import { useSupervisor, logOfficeOverride } from "./overrides.js";

export const CASH_KINDS = [
  "float",
  "drop",
  "pickup",
  "paid_out",
  "paid_in",
  "no_sale",
];
export const CASH_KIND_LABELS = /** @type {Record<string,string>} */ ({
  float: "Add float",
  drop: "Cash drop",
  pickup: "Cash pickup",
  paid_out: "Paid out",
  paid_in: "Paid in",
  no_sale: "No sale",
});
/** + adds to the drawer, - takes out of it, 0 leaves it alone. */
export const CASH_SIGN = /** @type {Record<string,number>} */ ({
  float: 1,
  paid_in: 1,
  drop: -1,
  pickup: -1,
  paid_out: -1,
  no_sale: 0,
});
/** Supervisor needed at the till for these (SPEC 7.3 step 6, 7.4). */
const NEEDS_SUPERVISOR = new Set(["drop", "pickup", "paid_out", "no_sale"]);
const OVERRIDE_KIND = /** @type {Record<string,string>} */ ({
  drop: "cash_drop",
  pickup: "cash_pickup",
  paid_out: "paid_out",
  no_sale: "no_sale",
});
/** Direction of the money for the reason check: in = into the drawer, out = out of it, none = no_sale. */
const CASH_DIRECTION = /** @type {Record<string,"in"|"out"|undefined>} */ ({
  float: "in",
  paid_in: "in",
  drop: "out",
  pickup: "out",
  paid_out: "out",
  no_sale: undefined,
});

/**
 * IP-INT2: till cash reasons are rows of FOUND's reason table (category `cash`, `cash_kinds` = the movements they serve).
 * The old store-till codes are seeded rows (migration 0760), so phones and old movements keep working.
 * @param {any} db @param {string} org @param {string} kind @param {string} code @param {string|null} note
 */
export async function requireCashReason(db, org, kind, code, note) {
  try {
    return await requireReason(db, org, code, {
      direction: CASH_DIRECTION[kind],
      note,
      cashKind: kind,
    });
  } catch (error) {
    if (error instanceof ApiError) refuse(error.message);
    throw error;
  }
}
/** The reasons offered for one cash movement kind: `{code, label, note?}`. @param {any} db @param {string} org @param {string} kind */
export async function cashReasonsFor(db, org, kind) {
  const rows = await listReasonCodes(db, org, { cashKind: kind });
  return rows.map((r) => ({
    code: r.code,
    label: r.label,
    ...(r.requiresNote ? { note: true } : {}),
  }));
}

/** Signed effect of one movement on expected cash, in centavos. @param {string} kind @param {bigint} amount */
export const cashEffect = (kind, amount) =>
  BigInt(CASH_SIGN[kind] ?? 0) * amount;

/**
 * Record one movement against an OPEN cashier session. Used by the device op (supervisor proof in the payload) and by the
 * office route (the logged-in supervisor is the approver). Included in expected cash by expectedCash().
 * @param {any} c store op context, or {db, register, shift, actor, payload, now, op}
 * @param {{id:string, officeActor?:any}} o
 */
export async function recordCashMovement(c, o) {
  const { db, register, shift, payload: p } = c;
  const kind = choice(p.kind, CASH_KINDS);
  const amount = kind === "no_sale" ? 0n : integer(p.amountCentavos, true);
  const note = text(p.note, 300);
  const reasonCode = String(p.reasonCode ?? "");
  await requireCashReason(db, register.organization_id ?? "sunpride", kind, reasonCode, note);
  const [day] =
    await db`select * from store_till_days where id=${shift.till_day_id}`;
  if (!day || day.status === "z_done")
    refuse("This sales day has its Z reading; no more cash movements");
  /** @type {string|null} */ let supervisorId = null;
  /** @type {string|null} */ let overrideId = null;
  if (o.officeActor) {
    supervisorId = o.officeActor.profileId;
    if (supervisorId === shift.cashier_id)
      refuse("A supervisor cannot approve their own cash movement");
    overrideId = NEEDS_SUPERVISOR.has(kind)
      ? await logOfficeOverride(db, register, o.officeActor, {
          kind: OVERRIDE_KIND[kind],
          tillDayId: day.id,
          shiftId: shift.id,
          refType: "cash_movement",
          refId: o.id,
          reason: note ?? reasonCode,
          amountCentavos: String(amount),
          cashierProfileId: shift.cashier_id,
        })
      : null;
  } else {
    const used = await useSupervisor(c, {
      kind: OVERRIDE_KIND[kind] ?? "cash_drop",
      refType: "cash_movement",
      refId: o.id,
      amountCentavos: String(amount),
      reason: note ?? reasonCode,
      required: NEEDS_SUPERVISOR.has(kind),
      tillDayId: day.id,
    });
    supervisorId = used?.supervisorProfileId ?? null;
    overrideId = used?.overrideId ?? null;
  }
  const [loc] =
    await db`select code from inventory_locations where id=${register.location_id}`;
  let slip = null;
  if (kind === "drop" || kind === "pickup" || kind === "paid_out")
    slip = await nextDocNumber(db, register.organization_id, {
      type: "REM",
      locationCode: slipCode(register, loc),
      at: c.now,
    });
  await db`insert into store_cash_movements(id,register_id,till_day_id,shift_id,kind,amount_centavos,reason_code,note,supervisor_profile_id,override_id,slip_number,recorded_by,captured_at) values(${o.id},${register.id},${day.id},${shift.id},${kind},${String(amount)},${reasonCode},${note},${supervisorId},${overrideId},${slip},${c.actor.profileId},${new Date(c.now)})`;
  return { entityId: o.id, slipNumber: slip };
}
/** @param {any} register @param {any} loc */
export const slipCode = (register, loc) =>
  String(register.terminal_code ?? loc?.code ?? "REG")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "-")
    .slice(0, 20);

/** Movements of a session or a day, newest last (the printed slip order). @param {any} db @param {{shiftId?:string, dayId?:string}} q */
export async function listMovements(db, q) {
  const rows = q.shiftId
    ? await db`select m.*,rec.name as recorded_by_name,sup.name as supervisor_name from store_cash_movements m join profiles rec on rec.id=m.recorded_by left join profiles sup on sup.id=m.supervisor_profile_id where m.shift_id=${uuid(q.shiftId)} order by m.captured_at,m.id limit 501`
    : await db`select m.*,rec.name as recorded_by_name,sup.name as supervisor_name from store_cash_movements m join profiles rec on rec.id=m.recorded_by left join profiles sup on sup.id=m.supervisor_profile_id where m.till_day_id=${uuid(q.dayId)} order by m.captured_at,m.id limit 501`;
  const labels = new Map(
    (await db`select code,label from inventory_reason_codes where category='cash'`).map(
      (/** @type {any} */ r) => [r.code, r.label],
    ),
  );
  return rows.slice(0, 500).map((/** @type {any} */ m) => ({
    id: m.id,
    shiftId: m.shift_id,
    kind: m.kind,
    label: CASH_KIND_LABELS[m.kind],
    amountCentavos: String(m.amount_centavos),
    effectCentavos: String(cashEffect(m.kind, BigInt(m.amount_centavos))),
    reasonCode: m.reason_code,
    reasonLabel: labels.get(m.reason_code) ?? m.reason_code,
    note: m.note,
    supervisorName: m.supervisor_name,
    slipNumber: m.slip_number,
    recordedBy: m.recorded_by_name,
    capturedAt: +new Date(m.captured_at),
  }));
}

/** Cash that should be in the drawer: opening float + cash tenders (refund reversals included) + float and paid-in
 * - drops, pickups and paid-outs. Never trusts a phone-supplied amount.
 * @param {any} db @param {string} shiftId */
export async function expectedCash(db, shiftId) {
  const [r] = await db`select s.opening_centavos
      + coalesce((select sum(t.amount_centavos) from store_tenders t where t.shift_id=s.id and t.method='cash'),0)
      + coalesce((select sum(case when m.kind in ('float','paid_in') then m.amount_centavos when m.kind in ('drop','pickup','paid_out') then -m.amount_centavos else 0 end) from store_cash_movements m where m.shift_id=s.id),0) as expected
      from store_shifts s where s.id=${shiftId}`;
  return BigInt(r.expected);
}
