import type { StatusState } from "../status-pill";
import { toBaseQty, type CasesPieces } from "../qty-cases-pieces";

/** Plain words for the van day (SPEC 3.10): trip, load-out, settlement. Everything here is pure so it is testable without a screen. */

export type LoadState =
  | "none"
  | "planned"
  | "suggested"
  | "approved"
  | "picking"
  | "dispatched"
  | "accepted"
  | "difference";
export type StageId =
  | "planned"
  | "loaded"
  | "on_route"
  | "back"
  | "settled"
  | "closed";
export type ActionKind =
  | "plan_trip"
  | "plan_load"
  | "review_load"
  | "approve_load"
  | "pick"
  | "dispatch"
  | "wait_seller"
  | "recount"
  | "decide"
  | "wait_start"
  | "view_trip"
  | "settle";

export type BoardRow = {
  vehicleId: string;
  vehicleCode: string;
  plateNumber: string;
  routeName: string;
  rosterId?: string;
  tripId: string | null;
  tripNumber: string | null;
  sellerName: string | null;
  crew: { profileId: string; name: string; role: string }[];
  onPhone: { profileId: string; name: string; role: string } | null;
  trip: { status: string; label: string; stage: StageId };
  load: {
    state: LoadState;
    detail: string;
    label: string;
    number: string | null;
    products: number;
    totalBase: number;
    cases: number;
    pieces: number;
    attention: string[];
    source: string | null;
    agreement: string | null;
    differenceCentavos: number;
  };
  cash: {
    expectedCentavos: number;
    salesCentavos: number;
    remittedCentavos: number | null;
  };
  loadIn: { number: string; status: string; variance: string } | null;
  settlement: { status: string; label: string };
  primary: { kind: ActionKind; label: string; enabled: boolean; tripId?: string };
  needsAttention: boolean;
};

export type DayBoard = {
  date: string;
  summary: {
    trucks: number;
    planned: number;
    needAttention: number;
    text: string;
    byStage: Record<StageId, number>;
    lastRun: {
      at: number;
      trigger: string;
      planned: number;
      needsAttention: number;
    } | null;
  };
  rows: BoardRow[];
};

export const STAGES: { id: StageId; label: string }[] = [
  { id: "planned", label: "Planned" },
  { id: "loaded", label: "Loaded" },
  { id: "on_route", label: "On route" },
  { id: "back", label: "Back" },
  { id: "settled", label: "Settled" },
  { id: "closed", label: "Closed" },
];

/** "5 cs 2 pc" for a whole truck's load (cases and loose pieces across its products). */
export const loadText = (cases: number, pieces: number) =>
  [cases ? `${cases} cs` : "", pieces || !cases ? `${pieces} pc` : ""].filter(Boolean).join(" ");

/** The pill for a load, in the board's own words. */
export const LOAD_PILL: Record<LoadState, { state: StatusState; label: string }> = {
  none: { state: "draft", label: "No load yet" },
  planned: { state: "planned", label: "Load planned" },
  suggested: { state: "planned", label: "Suggested" },
  approved: { state: "approved", label: "Approved" },
  picking: { state: "picking", label: "Picking" },
  dispatched: { state: "dispatched", label: "Dispatched" },
  accepted: { state: "accepted", label: "Accepted" },
  difference: { state: "needs_review", label: "Difference" },
};

/** Rows grouped under the board's columns, in order; empty columns are dropped. */
export function byStage(rows: BoardRow[]) {
  return STAGES.map((s) => ({
    ...s,
    rows: rows.filter((r) => r.trip.stage === s.id),
  })).filter((s) => s.rows.length);
}

/** The request behind a row's one button, or null when the button only opens something. */
export function actionRequest(
  row: Pick<BoardRow, "primary">,
  date: string,
): { path: string; body: Record<string, unknown> } | null {
  const tripId = row.primary.tripId;
  switch (row.primary.kind) {
    case "plan_trip":
      return { path: "/api/v1/van/trips/generate", body: { date } };
    case "approve_load":
      return tripId
        ? { path: "/api/v1/van/loads/approve-plan", body: { tripIds: [tripId] } }
        : null;
    case "pick":
      return tripId ? { path: "/api/v1/van/loads/pick", body: { tripId } } : null;
    case "dispatch":
      return tripId
        ? { path: "/api/v1/van/loads/dispatch", body: { tripId } }
        : null;
    default:
      return null;
  }
}

/** What a button that only opens something opens. */
export const opens = (kind: ActionKind) =>
  ({
    plan_load: "load",
    review_load: "load",
    recount: "recount",
    decide: "decide",
    view_trip: "trip",
    settle: "trip",
  })[kind as string] ?? null;

/** Suggested loads with nothing odd about them: the supervisor can approve these in one tap. */
export const cleanTripIds = (rows: BoardRow[]) =>
  rows
    .filter(
      (r) =>
        r.tripId &&
        r.load.state === "suggested" &&
        r.load.attention.length === 0 &&
        r.load.products > 0,
    )
    .map((r) => r.tripId as string);

export const approveAllRequest = (ids: string[]) => ({
  path: "/api/v1/van/loads/approve-plan",
  body: { tripIds: ids },
});

/** Short plain lines saying why a truck needs a person. */
export function attentionFor(row: BoardRow): string[] {
  const out = [...row.load.attention];
  if (!row.tripId) out.push("No trip yet for this rostered truck");
  if (row.load.detail === "recount")
    out.push("The seller counted a difference. The clerk recounts");
  if (row.load.detail === "disputed")
    out.push("Seller and clerk counted differently. A supervisor decides");
  return out;
}

/** One planned-load line as the screen edits it. */
export type PlanLine = {
  productId: string;
  code: string;
  name: string;
  caseBase: number;
  averageBase: number;
  mustCarryBase: number;
  shipFirstBase: number;
  onTruckBase: number;
  depotAvailableBase: number;
  historyTrips: number;
  suggestedBase: number;
  approvedBase: number | null;
  loadBase: number;
  edited: boolean;
  flags: string[];
};
export type PlanDetail = {
  tripId: string;
  tripNumber?: string;
  plan: null | {
    id: string;
    state: string;
    label: string;
    source: string;
    attention: string[];
    agreement: string | null;
    clerkName: string | null;
  };
  document?: null | { number: string; status: string; driverName: string | null; vehiclePlate: string | null; receiverName: string | null };
  lines: PlanLine[];
};

/** Why a line has its quantity, in words a supervisor can check against what they know. */
export function reasonsFor(l: PlanLine): string[] {
  const out: string[] = [];
  if (l.historyTrips)
    out.push(
      `Usually sells ${l.averageBase} pc (average of the last ${l.historyTrips} same-weekday trips)`,
    );
  else out.push("No sales history for this route and weekday");
  if (l.mustCarryBase) out.push(`Must carry at least ${l.mustCarryBase} pc`);
  if (l.shipFirstBase)
    out.push(`Ship first: ${l.shipFirstBase} pc of a batch that expires soon`);
  if (l.onTruckBase) out.push(`${l.onTruckBase} pc already on the truck`);
  if (l.flags.includes("depot_short"))
    out.push(`The depot only has ${l.depotAvailableBase} pc free`);
  if (l.flags.includes("no_case_size"))
    out.push("Case size not set. Pieces only until the office adds it.");
  return out;
}

/** The edits to send: only lines whose quantity changed from what the plan holds. */
export function editPayload(
  tripId: string,
  lines: PlanLine[],
  edits: Record<string, CasesPieces>,
) {
  const out: { productId: string; quantityBase: number }[] = [];
  for (const l of lines) {
    const e = edits[l.productId];
    if (!e) continue;
    const q = toBaseQty(e, l.caseBase);
    if (q !== l.loadBase) out.push({ productId: l.productId, quantityBase: q });
  }
  return { tripId, lines: out };
}

export const WEEKDAYS = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 7, label: "Sun" },
];

export type RosterRow = {
  rosterId: string;
  vehicleId: string;
  vehicleCode: string;
  plateNumber: string;
  routeName: string | null;
  sellerProfileId: string;
  sellerName: string;
  helperProfileId: string | null;
  helperName: string | null;
  driverProfileId: string | null;
  driverName: string | null;
  weekdays: number[];
  weekdayLabel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
};
export type RosterForm = {
  rosterId: string | null;
  vehicleId: string;
  routeId: string;
  sellerProfileId: string;
  helperProfileId: string;
  driverProfileId: string;
  weekdays: number[];
  effectiveFrom: string;
};
export const emptyRosterForm = (today: string): RosterForm => ({
  rosterId: null,
  vehicleId: "",
  routeId: "",
  sellerProfileId: "",
  helperProfileId: "",
  driverProfileId: "",
  weekdays: [1, 2, 3, 4, 5, 6],
  effectiveFrom: today,
});
export function rosterProblems(f: RosterForm): string[] {
  const out: string[] = [];
  if (!f.vehicleId) out.push("Choose the truck");
  if (!f.sellerProfileId) out.push("Choose the seller");
  if (!f.weekdays.length) out.push("Pick the days of the week");
  const people = [f.sellerProfileId, f.helperProfileId, f.driverProfileId].filter(Boolean);
  if (new Set(people).size !== people.length)
    out.push("The seller, helper and driver must be different people");
  return out;
}
export const rosterPayload = (f: RosterForm) => ({
  ...(f.rosterId ? { rosterId: f.rosterId } : {}),
  vehicleId: f.vehicleId,
  routeId: f.routeId || null,
  sellerProfileId: f.sellerProfileId,
  helperProfileId: f.helperProfileId || null,
  driverProfileId: f.driverProfileId || null,
  weekdays: f.weekdays,
  effectiveFrom: f.effectiveFrom,
});
export const toggleDay = (days: number[], n: number) =>
  days.includes(n) ? days.filter((d) => d !== n) : [...days, n].sort();
