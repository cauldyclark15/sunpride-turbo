import { nextDocNumber, manilaBusinessDate } from "../../core/docnum.js";
import { refuse } from "../van/model.js";
import { slipCode } from "./cash.js";

/** @param {string} ymd */
export function nextDate(ymd) {
  return new Date(Date.parse(ymd) + 86400000).toISOString().slice(0, 10);
}

/** @param {string} ymd */
export function previousDate(ymd) {
  return new Date(Date.parse(ymd) - 86400000).toISOString().slice(0, 10);
}
/** A day that can no longer take sales or a Z of its own: Z done, or closed without one (old backfilled days).
 * @param {string|null|undefined} status */
export const isDayFinished = (status) =>
  status === "z_done" || status === "closed_no_z";

/**
 * The till day a NEW cashier session joins. The register row is already locked by the caller.
 * A live day joins only when it is for today's Manila business date, or for yesterday while one of its sessions is still
 * open across midnight (IP-INT2FIX: a register that skipped Z readings before the till-day release never drags weeks of
 * old sales into one Z). "Today" is the capture time and the time the server received it, so an offline phone that
 * opens a session late still lands in the live day. With no such day, a new one starts on the Manila date of the capture
 * time, but never on or before a date that already has its day: a session opened after the Z belongs to the next date.
 * @param {any} db @param {any} register @param {number} at
 */
export async function tillDayForOpen(db, register, at) {
  const today = [manilaBusinessDate(at), manilaBusinessDate(Date.now())];
  const yesterday = today.map(previousDate);
  const live =
    await db`select d.*,exists(select 1 from store_shifts s left join store_shift_closures c on c.shift_id=s.id where s.till_day_id=d.id and c.id is null) as has_open_session from store_till_days d where d.register_id=${register.id} and d.status in ('open','closing') order by d.business_date for update of d`;
  const ymd = (/** @type {any} */ v) =>
    String(v?.toISOString?.() ?? v).slice(0, 10);
  const joinable = live.find(
    (/** @type {any} */ d) =>
      today.includes(ymd(d.business_date)) ||
      (yesterday.includes(ymd(d.business_date)) && d.has_open_session),
  );
  if (joinable) {
    if (joinable.status === "closing")
      refuse(
        "Day-end has started on this register. A supervisor must run the Z reading, or reopen the day.",
      );
    return joinable;
  }
  const [last] =
    await db`select max(business_date)::text as d from store_till_days where register_id=${register.id}`;
  let date = manilaBusinessDate(at);
  if (last.d && last.d >= date) date = nextDate(last.d);
  const doc = await nextDocNumber(db, register.organization_id, {
    type: "TILL",
    locationCode: slipCode(register, null),
    at,
  });
  const [row] =
    await db`insert into store_till_days(register_id,business_date,doc_number,opened_at) values(${register.id},${date},${doc},${new Date(at)}) returning *`;
  return row;
}

/** @param {any} db @param {string} id @param {boolean} [lock] */
export async function loadTillDay(db, id, lock = false) {
  const [d] = lock
    ? await db`select * from store_till_days where id=${id} for update`
    : await db`select * from store_till_days where id=${id}`;
  if (!d) refuse("Choose a till day", "not_found");
  return d;
}

/** Status the cashier / office sees for one session. @param {any} s joined row */
export function sessionStatus(s) {
  if (s.closed_at)
    return s.closure_kind === "forced"
      ? "force_closed"
      : (s.decision ?? (s.needs_review ? "needs_review" : "closed"));
  return s.suspended ? "suspended" : "open";
}
