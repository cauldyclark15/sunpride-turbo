import { addDays, date, day, fail } from "./validation.js";
export const DONE = new Set(["checked-out", "completed"]);
export const OPEN = new Set(["arrived", "checked-in", "in-progress"]);
export const RULE_VERSION = "fieldreports/2026-10-19";
export const TOPIC_LABELS = {
  siv_stt: "SIV and STT",
  buying_accounts: "Buying Accounts",
  program_utilization: "Program Utilization",
  report_submission: "Submission of Reports",
  inventory_days: "Inventory Days Level",
  marketing_program: "Marketing Program Execution",
  other_operational: "Other Operational Issues",
};
export const REASON_LABELS = {
  outside_mcp: "Not in the approved MCP",
  removed_from_plan: "Stop was taken out of the approved MCP",
  plan_not_approved: "MCP for this stop is not approved",
  not_completed: "Call not finished",
  still_open: "Call still open",
  no_location: "No location recorded at check-in",
  location_rejected: "Location rejected by a supervisor",
  late_pending: "Sent after the 10 PM close, waiting for review",
  late_rejected: "Sent after the 10 PM close and rejected",
  no_report: "No call report recorded",
  no_call_sheet: "Call sheet not filled for this account",
  forms_missing: "Required forms for the call's purpose are missing",
  not_visited: "Planned stop not visited",
};
export const WW_GAPS = {
  bcp_observation: "Record at least one Basic Call Procedure (BCP) observation",
  psf_observation:
    "Record at least one Persuasive Selling Format (PSF) observation",
  training_log: "Write the training log",
  trade_development: "Write the trade development remark",
  training_log_discussed:
    "Review and discuss the training log with the trainee",
  pre_call_documents: "Pick the reports reviewed before the call",
  pre_call_remarks: "Write the pre-call review remarks",
  post_call_swot: "Write all four SWOT remarks after the call",
  mcp_missing: "The trainee has no approved MCP stops on this day",
  mcp_unfinished: "The trainee has not finished the day's MCP",
  truck_missing: "Name the truck for a truck work-with",
  truck_not_ridden: "Confirm you rode the named truck",
};
/** @param {any} s @param {{planned:number,done:number}} m */
export function completionGaps(s, m) {
  const gaps = [];
  const obs = s.observations ?? [];
  if (!obs.some((/** @type {any} */ o) => o.area === "bcp"))
    gaps.push("bcp_observation");
  if (!obs.some((/** @type {any} */ o) => o.area === "psf"))
    gaps.push("psf_observation");
  if (s.objective === "training") {
    if (!s.trainingLog?.topics?.trim()) gaps.push("training_log");
    if (!s.trainingLog?.tradeDevelopment?.trim())
      gaps.push("trade_development");
    if (!s.trainingLog?.discussedWithTrainee)
      gaps.push("training_log_discussed");
  } else {
    if (!s.preCall?.documents?.length) gaps.push("pre_call_documents");
    if (!s.preCall?.remarks?.trim()) gaps.push("pre_call_remarks");
    if (
      !["strengths", "weaknesses", "opportunities", "threats"].every((k) =>
        s.postCall?.[k]?.trim(),
      )
    )
      gaps.push("post_call_swot");
    if (!m.planned) gaps.push("mcp_missing");
    else if (m.done < m.planned) gaps.push("mcp_unfinished");
    if (s.mode === "truck") {
      if (!s.truckReference?.trim()) gaps.push("truck_missing");
      if (!s.rodeWithTruck) gaps.push("truck_not_ridden");
    }
  }
  return gaps.map((code) => ({
    code,
    label: /** @type {any} */ (WW_GAPS)[code],
  }));
}
/** @param {string} d */
export function weekOf(d) {
  const start = addDays(
    date(d),
    -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7),
  );
  return { start, end: addDays(start, 6) };
}
/** @param {string} d */
export function monthOf(d) {
  date(d);
  const start = d.slice(0, 7) + "-01";
  const end = new Date(
    Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0),
  )
    .toISOString()
    .slice(0, 10);
  return { start, end };
}
/** @param {any[]} sessions @param {string} from @param {string} to */
export function countIn(sessions, from, to) {
  return sessions.filter(
    (s) =>
      s.status === "completed" &&
      day(s.service_date ?? s.serviceDate) >= from &&
      day(s.service_date ?? s.serviceDate) <= to,
  ).length;
}
/** @param {number} count @param {number|null} min @param {string} end @param {string} now */
export function cadenceState(count, min, end, now) {
  return min === null
    ? "no_standard"
    : count >= min
      ? "met"
      : now > end
        ? "behind"
        : "on_track";
}
/** @param {string} d */
export function oneMonthAfter(d) {
  date(d);
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(
    Date.UTC(y, m, Math.min(dd, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())),
  )
    .toISOString()
    .slice(0, 10);
}
/** @param {any} i @param {string} asOf */
export function effectiveStatus(i, asOf) {
  return i.status === "completed"
    ? "completed"
    : i.status === "overdue" || i.timeline < asOf
      ? "overdue"
      : "on_going";
}
/** @param {string} status */
export function carriesOver(status) {
  return status !== "completed";
}
/** @param {any} i @param {string} asOf */
export function rootCauseDue(i, asOf) {
  return carriesOver(i.status) && asOf >= oneMonthAfter(i.openedOn);
}
/** @param {any} s */
export function finalizeGaps(s) {
  const gaps = [];
  if (!s.acknowledgedByName?.trim())
    gaps.push({
      code: "acknowledged_by",
      label: "Name who acknowledged and committed for the partner",
    });
  if (!s.nextContactDate || s.nextContactDate <= s.meetingDate)
    gaps.push({
      code: "next_contact",
      label: "Set the next contact date after the meeting",
    });
  if (!s.items.length)
    gaps.push({ code: "no_items", label: "Add at least one gap or issue" });
  for (const [key, code, label] of [
    ["gap", "item_gap", "Describe every gap or issue"],
    ["agreement", "item_agreement", "Write the agreement for every line"],
    [
      "correctiveAction",
      "item_action",
      "Write the corrective action for every line",
    ],
    [
      "responsible",
      "item_responsible",
      "Name who is responsible for every line",
    ],
    ["timeline", "item_timeline", "Give every line a timeline date"],
  ])
    if (s.items.some((/** @type {any} */ i) => !i[key]?.trim()))
      gaps.push({ code, label });
  if (
    s.items.some(
      (/** @type {any} */ i) =>
        rootCauseDue(i, s.meetingDate) && !i.rootCause?.trim(),
    )
  )
    gaps.push({
      code: "root_cause",
      label: "Write the root-cause review for lines open over a month",
    });
  return gaps;
}
/** @param {any} facts */
export function classifyVisit(facts) {
  const reasons = [];
  const notes = [];
  if (facts.source === "unplanned" || !facts.hasPlannedLink)
    reasons.push("outside_mcp");
  else if (!facts.planned || facts.planned.status !== "planned")
    reasons.push("removed_from_plan");
  else if (
    !["approved", "active", "superseded"].includes(facts.planned.planStatus)
  )
    reasons.push("plan_not_approved");
  if (OPEN.has(facts.state)) reasons.push("still_open");
  else if (!DONE.has(facts.state)) reasons.push("not_completed");
  if (facts.location.some((/** @type {any} */ l) => l.status === "rejected"))
    reasons.push("location_rejected");
  else if (
    !facts.location.some(
      (/** @type {any} */ l) =>
        l.event === "check_in" &&
        (l.hasFix || l.status === "approved_exception"),
    )
  )
    reasons.push("no_location");
  if (
    facts.location.some(
      (/** @type {any} */ l) => l.status === "pending_review" && l.hasFix,
    )
  )
    notes.push("location_unreviewed");
  if (
    facts.location.some(
      (/** @type {any} */ l) => l.status === "approved_exception",
    )
  )
    notes.push("location_exception_approved");
  if (facts.lateReviewStatus === "pending_review") reasons.push("late_pending");
  if (facts.lateReviewStatus === "rejected") reasons.push("late_rejected");
  if (facts.lateReviewStatus === "accepted") notes.push("late_accepted");
  if (DONE.has(facts.state)) {
    if (!facts.activityCount) reasons.push("no_report");
    else {
      if (facts.callSheetRequired && !facts.hasCallSheet)
        reasons.push("no_call_sheet");
      if (facts.requiredMissing.length) reasons.push("forms_missing");
    }
  }
  const held = new Set([
    "still_open",
    "no_location",
    "late_pending",
    "forms_missing",
  ]);
  return {
    status: reasons.some((r) => !held.has(r))
      ? "invalid"
      : reasons.length
        ? "held"
        : "valid",
    reasons,
    notes,
  };
}
/** @param {string|null} code */
export function reportKindFor(code) {
  return ["SCDM", "CDM_KA", "CDM_GT", "SR_CDS", "CDS", "DS"].includes(
    code ?? "",
  )
    ? "dar"
    : ["RDS", "RS", "PMOT", "PMOT_EXTRUCK", "PM_STALLS"].includes(code ?? "")
      ? "roar"
      : null;
}
/** @param {string} d */
export function reportDueAt(d) {
  return Date.parse(date(d) + "T22:00:00+08:00");
}
/** @param {{serviceDate:string,sellingDay:boolean,firstSubmittedAt:number|null,now:number}} i */
export function completenessOf(i) {
  if (i.firstSubmittedAt !== null)
    return i.firstSubmittedAt <= reportDueAt(i.serviceDate)
      ? "submitted"
      : "late";
  if (!i.sellingDay) return "off_day";
  if (i.now < Date.parse(i.serviceDate + "T00:00:00+08:00")) return "upcoming";
  return i.now <= reportDueAt(i.serviceDate) ? "due" : "missing";
}
/** @param {string} status */
export function countsAsSale(status) {
  return !["draft", "rejected", "voided"].includes(status);
}
/** @param {any} n */
export function money(n) {
  const s = String(n);
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) fail("Invalid money value");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) fail("Amount exceeds supported range");
  return s.startsWith("-") ? -cents : cents;
}
/** @param {number} actual @param {number|null} target */
export function percentOf(actual, target) {
  return target !== null && target > 0
    ? Math.floor((actual * 100) / target)
    : null;
}
/** @param {string|null} cat */
export function memoCategory(cat) {
  const s = cat ?? "";
  return /canned/i.test(s)
    ? "Canned"
    : /mix/i.test(s)
      ? "Mixes"
      : /frozen/i.test(s)
        ? "Frozen"
        : s || "Uncategorized";
}
