import { nextDocNumber, manilaBusinessDate } from "../../core/docnum.js";
import { refuse } from "../van/model.js";
import { slipCode } from "./cash.js";

/** @param {string} ymd */
export function nextDate(ymd) {
  return new Date(Date.parse(ymd) + 86400000).toISOString().slice(0, 10);
}

/**
 * The till day a NEW cashier session joins. The register row is already locked by the caller.
 * A live day (open) is joined whatever the clock says, so a session that crosses midnight stays in its day.
 * With no live day, a new one starts on the Manila date of the capture time, but never on or before a date that already
 * has its Z: a session opened after the Z belongs to the next business date.
 * @param {any} db @param {any} register @param {number} at
 */
export async function tillDayForOpen(db, register, at) {
  const [live] =
    await db`select * from store_till_days where register_id=${register.id} and status<>'z_done' order by business_date limit 1 for update`;
  if (live) {
    if (live.status === "closing")
      refuse(
        "Day-end has started on this register. A supervisor must run the Z reading, or reopen the day.",
      );
    return live;
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
