/* ANA-007 management exception dashboard. Managers manage exceptions rather than inspect
 * every transaction (blueprint §58). Four bounded reads, each its own query so one failing
 * section never blanks the others:
 * - `field` (paged people): missed high-value outlets and people materially behind plan;
 * - `geofence`: repeated off-radius / unreliable location fixes by person and outlet;
 * - `operations`: SAP failures, unclosed van trips, stock variances (cash: not recorded yet);
 * - `outOfStock`: outlets and products repeatedly found out of stock.
 *
 * Access: supervision readers (`people.read` + `visit.read`) who also hold `report.read`,
 * always inside their own organizational scope, never wider. Inventory sections also need
 * `inventory.read`; SAP needs `integration.read` and national scope (integration events and
 * connector heartbeats carry no unit, so a regional view would be partial — shown as
 * unavailable instead). Pure rules and thresholds: ./exception_model.ts; meanings in
 * docs/architecture/MANAGEMENT_EXCEPTION_DASHBOARD.md.
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { localDate, monthBounds } from "../coverage/validation";
import {
  countsAsSale,
  dailyTarget,
  LATE_ORDER_WINDOW_MS,
  manilaDateOf,
  monthOf,
  saleInstant,
  toMinor,
} from "../dsr/model";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { capabilityRoles, requireCapability } from "../lib/capabilities";
import type { AppRole } from "../lib/roles";
import { rootOrgUnitId } from "../lib/scope";
import { resolveOutletScopeAt } from "../outlets/validation";
import {
  DEFAULT_SELLING_WEEKDAYS,
  isSellingDay,
  sellingDatesInMonth,
} from "../sfa/selling_days";
import { standardAt, standardsFor } from "../sfa/standards";
import {
  evidenceDecision,
  supervisorContext,
  teamMembers,
  type SupervisorContext,
  type TeamMember,
} from "../supervision/access";
import { dayCloseAt, DONE_STATES } from "../supervision/model";
import { subjectTargetAt } from "../targets/sales";
import {
  behindPlan,
  connectorDown,
  EXCEPTION_PAGE_SIZE,
  EXCEPTION_SOURCE,
  fieldTotals,
  isHighValueOutlet,
  MAX_LISTED,
  MAX_MISSED_LISTED,
  MAX_PERIOD_ORDERS,
  MAX_PERIOD_ROWS,
  oosHotspots,
  REPEAT_GEOFENCE_MIN,
  repeated,
  sapIssueKind,
  tripUnclosed,
  UNCLOSED_TRIP_STATUSES,
  type OosFinding,
} from "./exception_model";
import { periodError } from "./productivity_model";

const DAY_MS = 86_400_000;
/** Location fixes read per period and scope (off-radius rows only). */
const MAX_EVIDENCE = 2_000;
/** Shelf findings read per period and scope. */
const MAX_AVAILABILITY = 4_000;
/** Inventory locations inspected per read. */
const MAX_LOCATIONS = 150;
const MAX_TRIPS_PER_STATUS = 20;
const MAX_COUNTS_PER_STATUS = 20;
const MAX_COUNT_LINES = 500;
const MAX_DIFFERENCES = 200;
const MAX_SAP_PER_STATUS = 200;
const MAX_ERROR_TEXT = 160;

const nullableNumber = v.union(v.number(), v.null());
const nullableString = v.union(v.string(), v.null());

const periodArgs = {
  from: v.string(),
  to: v.string(),
  orgUnitId: v.optional(v.id("orgUnits")),
};
const peopleArgs = {
  ...periodArgs,
  channel: v.optional(v.string()),
  directOnly: v.optional(v.boolean()),
};

type PeriodFilters = {
  from: string;
  to: string;
  orgUnitId?: Id<"orgUnits">;
  channel?: string;
  directOnly?: boolean;
};

function checkPeriod(from: string, to: string) {
  localDate(from);
  localDate(to);
  const error = periodError(from, to);
  if (error) throw new ConvexError(error);
}

async function context(ctx: QueryCtx, args: PeriodFilters) {
  checkPeriod(args.from, args.to);
  const filters = {
    serviceDate: args.to,
    ...(args.orgUnitId ? { orgUnitId: args.orgUnitId } : {}),
    ...(args.channel ? { channel: args.channel } : {}),
    ...(args.directOnly ? { directOnly: true } : {}),
  };
  const sc = await supervisorContext(ctx, filters);
  await requireCapability(ctx, "report.read");
  return { sc, filters };
}

function holds(
  sc: SupervisorContext,
  capability: Parameters<typeof capabilityRoles>[0],
) {
  return (
    sc.profile.role === "super_admin" ||
    (capabilityRoles(capability) as readonly AppRole[]).includes(
      sc.profile.role as AppRole,
    )
  );
}

/**
 * National = the caller may read rows that have no organizational unit (unmapped
 * locations, integration events): super admin, or an admin/analyst/operations profile
 * placed on the national root, and only while the view is not narrowed to a sub-unit.
 */
async function nationalView(
  ctx: QueryCtx,
  sc: SupervisorContext,
  orgUnitId: Id<"orgUnits"> | undefined,
  roles: readonly string[],
) {
  const root = await rootOrgUnitId(ctx);
  if (orgUnitId && orgUnitId !== root) return false;
  if (sc.profile.role === "super_admin") return true;
  return (
    !!root && roles.includes(sc.profile.role) && sc.profile.orgUnitId === root
  );
}

/**
 * Canonical outlet authorization for historical sources: the outlet's CURRENT persisted
 * owner (territory owner, else custodian), exactly as outlet detail resolves it, must be
 * inside the caller's current scope. Historical unit stamps alone are not enough: after an
 * outlet moves from Region A to B, A's manager must no longer receive its identity or
 * findings. Unresolvable ownership (e.g. overlapping rows) fails closed. Cached per read.
 */
function currentOutletGate(ctx: QueryCtx, sc: SupervisorContext) {
  const now = Date.now();
  const cache = new Map<Id<"outlets">, boolean>();
  return async (outletId: Id<"outlets">) => {
    const known = cache.get(outletId);
    if (known !== undefined) return known;
    let allowed = false;
    try {
      const current = await resolveOutletScopeAt(ctx, outletId, now);
      allowed = sc.scope.has(current.orgUnitId);
    } catch {
      allowed = false;
    }
    cache.set(outletId, allowed);
    return allowed;
  };
}
type OutletGate = ReturnType<typeof currentOutletGate>;

// ---------------------------------------------------------------------------------------
// Field: missed high-value outlets and people materially behind plan (paged).

const missedStop = v.object({
  plannedVisitId: v.id("plannedVisits"),
  outletId: v.id("outlets"),
  outletCode: v.string(),
  outletName: v.string(),
  classification: nullableString,
  serviceDate: v.string(),
});

const fieldRow = v.object({
  profileId: v.id("profiles"),
  name: v.string(),
  employeeCode: nullableString,
  positionLabel: nullableString,
  channel: v.string(),
  direct: v.boolean(),
  /** Planned stops of closed days (after the 10 PM close) and how many were completed. */
  plannedClosed: v.number(),
  doneClosed: v.number(),
  planPct: nullableNumber,
  /** PHP centavos: sales on closed days that had a target, and the sum of those targets. */
  sales: v.number(),
  salesTarget: nullableNumber,
  salesPct: nullableNumber,
  reasons: v.array(v.union(v.literal("plan"), v.literal("sales"))),
  missedHighValueCount: v.number(),
  missedHighValue: v.array(missedStop),
  /** The person's period hit a read cap; figures cover what was read. */
  truncated: v.boolean(),
});
export type FieldRow = typeof fieldRow.type;

const fieldTotalsValidator = v.object({
  people: v.number(),
  behind: v.number(),
  behindPlan: v.number(),
  behindSales: v.number(),
  missedHighValue: v.number(),
  peopleMissingHighValue: v.number(),
});

async function personPeriod(
  ctx: QueryCtx,
  sc: SupervisorContext,
  member: TeamMember,
  from: string,
  to: string,
  outletOf: (id: Id<"outlets">) => Promise<Doc<"outlets"> | null>,
  outletAllowed: OutletGate,
  now: number,
): Promise<FieldRow> {
  const profileId = member.profile._id;
  const plannedRows = await ctx.db
    .query("plannedVisits")
    .withIndex("by_assigneeProfileId_and_serviceDate", (q) =>
      q
        .eq("assigneeProfileId", profileId)
        .gte("serviceDate", from)
        .lte("serviceDate", to),
    )
    .take(MAX_PERIOD_ROWS + 1);
  const visitRows = await ctx.db
    .query("visitExecutions")
    .withIndex("by_organizationId_and_assigneeProfileId_and_serviceDate", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("assigneeProfileId", profileId)
        .gte("serviceDate", from)
        .lte("serviceDate", to),
    )
    .take(MAX_PERIOD_ROWS + 1);
  let truncated =
    plannedRows.length > MAX_PERIOD_ROWS || visitRows.length > MAX_PERIOD_ROWS;
  const closed = (date: string) => dayCloseAt(date) < now;
  const planned: Doc<"plannedVisits">[] = [];
  for (const row of plannedRows.slice(0, MAX_PERIOD_ROWS))
    if (
      row.status === "planned" &&
      closed(row.serviceDate) &&
      // The selected unit filter (sc.units), not the caller's whole scope: a Region A
      // view must not list stops this person once served in Region B.
      sc.units.has(row.approvedSnapshot.orgUnitId) &&
      // And the outlet's current owner must still be in the caller's scope.
      (await outletAllowed(row.outletId))
    )
      planned.push(row);
  const done = new Set(
    visitRows
      .slice(0, MAX_PERIOD_ROWS)
      .filter(
        (visit) =>
          sc.units.has(visit.orgUnitId) &&
          DONE_STATES.has(visit.state) &&
          visit.plannedVisitId !== undefined,
      )
      .map((visit) => visit.plannedVisitId as string),
  );
  const doneClosed = planned.filter((row) => done.has(row._id)).length;
  const missedHighValue: FieldRow["missedHighValue"] = [];
  for (const stop of planned) {
    if (done.has(stop._id)) continue;
    const outlet = await outletOf(stop.outletId);
    if (!outlet || !isHighValueOutlet(outlet)) continue;
    missedHighValue.push({
      plannedVisitId: stop._id,
      outletId: stop.outletId,
      outletCode: stop.approvedSnapshot.outletCode,
      outletName: stop.approvedSnapshot.outletName,
      classification: outlet.classification ?? null,
      serviceDate: stop.serviceDate,
    });
  }
  missedHighValue.sort(
    (a, b) =>
      b.serviceDate.localeCompare(a.serviceDate) ||
      a.outletCode.localeCompare(b.outletCode),
  );

  // Sales on closed days, attributed to the day the salesman wrote them (DSR rule).
  const start = localDate(from);
  const end = localDate(to) + DAY_MS;
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_salespersonSubject_and_createdAt", (q) =>
      q
        .eq("salespersonSubject", member.profile.authSubject)
        .gte("createdAt", start)
        .lt("createdAt", end + LATE_ORDER_WINDOW_MS),
    )
    .take(MAX_PERIOD_ORDERS + 1);
  if (orders.length > MAX_PERIOD_ORDERS) truncated = true;
  const salesByDay = new Map<string, number>();
  for (const order of orders.slice(0, MAX_PERIOD_ORDERS)) {
    if (
      (order.organizationId !== undefined &&
        order.organizationId !== SUNPRIDE_ORGANIZATION_ID) ||
      !countsAsSale(order.status)
    )
      continue;
    const instant = saleInstant(order);
    if (instant < start || instant >= end) continue;
    const date = manilaDateOf(instant);
    salesByDay.set(date, (salesByDay.get(date) ?? 0) + toMinor(order.total));
  }

  // Each closed day's target: the daily target, else the monthly spread over selling days.
  const positionId = member.assignment.positionId ?? member.profile.positionId;
  const standards = positionId ? await standardsFor(ctx, positionId) : [];
  const subject = { kind: "employee" as const, profileId };
  const monthly = new Map<string, number | null>();
  let sales = 0;
  let salesTarget: number | null = null;
  for (
    let day = start;
    day < end && dayCloseAt(manilaDateOf(day)) < now;
    day += DAY_MS
  ) {
    const date = manilaDateOf(day);
    const weekdays =
      standardAt(standards, day + DAY_MS / 2)?.sellingWeekdays ??
      DEFAULT_SELLING_WEEKDAYS;
    const month = monthOf(date);
    if (!monthly.has(month))
      monthly.set(
        month,
        (
          await subjectTargetAt(
            ctx,
            subject,
            "monthly",
            "sales_value",
            monthBounds(month).from,
          )
        )?.value ?? null,
      );
    const daily = await subjectTargetAt(
      ctx,
      subject,
      "daily",
      "sales_value",
      day,
    );
    const target = dailyTarget({
      daily: daily?.value ?? null,
      monthly: monthly.get(month) ?? null,
      sellingDay: isSellingDay(date, weekdays),
      sellingDaysInMonth: sellingDatesInMonth(month, weekdays).length,
    }).value;
    if (target === null) continue;
    salesTarget = (salesTarget ?? 0) + target;
    sales += salesByDay.get(date) ?? 0;
  }

  const judged = behindPlan({
    plannedClosed: planned.length,
    doneClosed,
    sales,
    salesTarget,
  });
  return {
    profileId,
    name: member.profile.name,
    employeeCode: member.profile.employeeCode ?? null,
    positionLabel: member.positionLabel,
    channel: member.channel,
    direct: member.direct,
    plannedClosed: planned.length,
    doneClosed,
    planPct: judged.planPct,
    sales,
    salesTarget,
    salesPct: judged.salesPct,
    reasons: judged.reasons,
    missedHighValueCount: missedHighValue.length,
    missedHighValue: missedHighValue.slice(0, MAX_MISSED_LISTED),
    truncated,
  };
}

/**
 * One page of field people in scope over the period. Only people with an exception are
 * returned (materially behind plan, or a missed high-value outlet); totals count everyone
 * on the page. Page 0 tells the web how many pages exist.
 */
export const field = query({
  args: { ...peopleArgs, page: v.optional(v.number()) },
  returns: v.object({
    from: v.string(),
    to: v.string(),
    page: v.number(),
    pageCount: v.number(),
    peopleInScope: v.number(),
    truncated: v.boolean(),
    sourceRef: v.string(),
    rows: v.array(fieldRow),
    totals: fieldTotalsValidator,
  }),
  handler: async (ctx, args) => {
    const page = args.page ?? 0;
    if (!Number.isInteger(page) || page < 0)
      throw new ConvexError("Page must be a whole number from 0");
    const { sc, filters } = await context(ctx, args);
    const { members, truncated } = await teamMembers(ctx, sc, filters);
    const pageCount = Math.max(
      1,
      Math.ceil(members.length / EXCEPTION_PAGE_SIZE),
    );
    if (page >= pageCount) throw new ConvexError("Page is out of range");
    const outlets = new Map<Id<"outlets">, Doc<"outlets"> | null>();
    const outletOf = async (id: Id<"outlets">) => {
      if (!outlets.has(id)) outlets.set(id, await ctx.db.get(id));
      return outlets.get(id) ?? null;
    };
    const now = Date.now();
    const outletAllowed = currentOutletGate(ctx, sc);
    const rows: FieldRow[] = [];
    for (const member of members.slice(
      page * EXCEPTION_PAGE_SIZE,
      (page + 1) * EXCEPTION_PAGE_SIZE,
    ))
      rows.push(
        await personPeriod(
          ctx,
          sc,
          member,
          args.from,
          args.to,
          outletOf,
          outletAllowed,
          now,
        ),
      );
    return {
      from: args.from,
      to: args.to,
      page,
      pageCount,
      peopleInScope: members.length,
      truncated: truncated || rows.some((row) => row.truncated),
      sourceRef: EXCEPTION_SOURCE,
      rows: rows.filter(
        (row) => row.reasons.length > 0 || row.missedHighValueCount > 0,
      ),
      totals: fieldTotals(rows),
    };
  },
});

// ---------------------------------------------------------------------------------------
// Geofence: repeated off-radius or unreliable fixes.

const OFF_RADIUS_STATUSES = [
  "pending_review",
  "approved_exception",
  "rejected",
] as const;

/**
 * People and outlets with at least REPEAT_GEOFENCE_MIN location fixes outside the radius,
 * unavailable or unreliable in the period. The client set no check-in distance (call answer
 * 13), so these are for tracing a day, not blocking it; open = awaiting a decision.
 */
export const geofence = query({
  args: peopleArgs,
  returns: v.object({
    from: v.string(),
    to: v.string(),
    truncated: v.boolean(),
    issues: v.number(),
    open: v.number(),
    people: v.array(
      v.object({
        profileId: v.id("profiles"),
        name: v.string(),
        channel: v.string(),
        issues: v.number(),
        open: v.number(),
        outlets: v.number(),
        mock: v.number(),
        lastAt: v.number(),
      }),
    ),
    outlets: v.array(
      v.object({
        outletId: v.id("outlets"),
        outletCode: v.string(),
        outletName: v.string(),
        issues: v.number(),
        people: v.number(),
        lastAt: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const { sc, filters } = await context(ctx, args);
    const { members, truncated: peopleTruncated } = await teamMembers(
      ctx,
      sc,
      filters,
    );
    const team = new Map(
      members.map((member) => [member.profile._id as string, member]),
    );
    const start = localDate(args.from);
    const end = localDate(args.to) + DAY_MS;
    const visits = new Map<
      Id<"visitExecutions">,
      Doc<"visitExecutions"> | null
    >();
    type Issue = {
      profileId: Id<"profiles">;
      outletId: Id<"outlets">;
      open: boolean;
      mock: boolean;
      at: number;
    };
    const issues: Issue[] = [];
    const outletAllowed = currentOutletGate(ctx, sc);
    let read = 0;
    let truncated = peopleTruncated;
    for (const unitId of sc.units)
      for (const status of OFF_RADIUS_STATUSES) {
        if (read >= MAX_EVIDENCE) {
          truncated = true;
          break;
        }
        const rows = await ctx.db
          .query("visitLocationEvidence")
          .withIndex("by_orgUnitId_and_reviewStatus_and_serverTime", (q) =>
            q
              .eq("orgUnitId", unitId)
              .eq("reviewStatus", status)
              .gte("serverTime", start)
              .lt("serverTime", end),
          )
          .take(MAX_EVIDENCE - read + 1);
        const room = MAX_EVIDENCE - read;
        if (rows.length > room) truncated = true;
        read += Math.min(rows.length, room);
        for (const row of rows.slice(0, room)) {
          if (row.result === "within_radius") continue;
          if (!visits.has(row.visitId))
            visits.set(row.visitId, await ctx.db.get(row.visitId));
          const visit = visits.get(row.visitId);
          if (!visit || !team.has(visit.assigneeProfileId)) continue;
          if (!(await outletAllowed(visit.outletId))) continue;
          issues.push({
            profileId: visit.assigneeProfileId,
            outletId: visit.outletId,
            open:
              row.reviewStatus === "pending_review" &&
              !(await evidenceDecision(ctx, row._id)),
            mock: row.mockSignal === true,
            at: row.serverTime,
          });
        }
      }
    const people = repeated(
      issues,
      (row) => row.profileId,
      REPEAT_GEOFENCE_MIN,
    ).map(({ key, rows }) => {
      const member = team.get(key)!;
      return {
        profileId: member.profile._id,
        name: member.profile.name,
        channel: member.channel,
        issues: rows.length,
        open: rows.filter((row) => row.open).length,
        outlets: new Set(rows.map((row) => row.outletId)).size,
        mock: rows.filter((row) => row.mock).length,
        lastAt: Math.max(...rows.map((row) => row.at)),
      };
    });
    const outlets = [];
    for (const { key, rows } of repeated(
      issues,
      (row) => row.outletId,
      REPEAT_GEOFENCE_MIN,
    )) {
      const outlet = await ctx.db.get(key as Id<"outlets">);
      outlets.push({
        outletId: key as Id<"outlets">,
        outletCode: outlet?.code ?? "—",
        outletName: outlet?.name ?? "Unknown outlet",
        issues: rows.length,
        people: new Set(rows.map((row) => row.profileId)).size,
        lastAt: Math.max(...rows.map((row) => row.at)),
      });
    }
    return {
      from: args.from,
      to: args.to,
      truncated,
      issues: issues.length,
      open: issues.filter((row) => row.open).length,
      people: people.slice(0, MAX_LISTED),
      outlets: outlets.slice(0, MAX_LISTED),
    };
  },
});

// ---------------------------------------------------------------------------------------
// Operations: SAP failures, unclosed van trips, stock and cash variances.

const unavailable = v.object({
  available: v.literal(false),
  reason: v.string(),
});

const sapSection = v.union(
  unavailable,
  v.object({
    available: v.literal(true),
    truncated: v.boolean(),
    failed: v.number(),
    deadLetter: v.number(),
    stuck: v.number(),
    connectorsDown: v.array(
      v.object({
        connectorId: v.string(),
        status: v.string(),
        lastSeenAt: v.number(),
      }),
    ),
    items: v.array(
      v.object({
        eventId: v.string(),
        kind: v.union(
          v.literal("failed"),
          v.literal("dead_letter"),
          v.literal("stuck"),
        ),
        direction: v.string(),
        eventType: v.string(),
        attempts: v.number(),
        receivedAt: v.number(),
        documentRef: nullableString,
        lastError: nullableString,
      }),
    ),
  }),
);

const tripsSection = v.union(
  unavailable,
  v.object({
    available: v.literal(true),
    truncated: v.boolean(),
    items: v.array(
      v.object({
        routeSessionId: v.id("truckRouteSessions"),
        routeCode: v.string(),
        truckCode: v.string(),
        salespersonName: v.string(),
        status: v.string(),
        openedAt: v.number(),
      }),
    ),
  }),
);

const stockSection = v.union(
  unavailable,
  v.object({
    available: v.literal(true),
    truncated: v.boolean(),
    counts: v.array(
      v.object({
        sessionId: v.id("stockCountSessions"),
        countNumber: v.string(),
        countType: v.string(),
        status: v.string(),
        open: v.boolean(),
        locationCode: v.string(),
        locationName: v.string(),
        snapshotAt: v.number(),
        varianceLines: v.number(),
        missingLines: v.number(),
        overLines: v.number(),
      }),
    ),
    /** Blind counts whose variance is withheld because the reader created or counted them. */
    blindWithheld: v.number(),
    sapDifferences: v.object({
      open: v.number(),
      byClassification: v.array(
        v.object({ classification: v.string(), count: v.number() }),
      ),
      unmappedHidden: v.boolean(),
    }),
  }),
);

function shortError(text: string | undefined) {
  if (!text) return null;
  return text.length > MAX_ERROR_TEXT
    ? `${text.slice(0, MAX_ERROR_TEXT - 1)}…`
    : text;
}

async function sapIssues(
  ctx: QueryCtx,
  sc: SupervisorContext,
  orgUnitId: Id<"orgUnits"> | undefined,
  now: number,
) {
  if (!holds(sc, "integration.read"))
    return {
      available: false as const,
      reason: "Needs SAP integration access",
    };
  if (!(await nationalView(ctx, sc, orgUnitId, ["admin", "operations"])))
    return {
      available: false as const,
      reason: "SAP events are national; shown only on the national view",
    };
  let truncated = false;
  const items = [];
  const counts = { failed: 0, dead_letter: 0, stuck: 0 };
  for (const status of [
    "failed",
    "dead_letter",
    "pending",
    "processing",
  ] as const) {
    const rows = await ctx.db
      .query("integrationEvents")
      .withIndex("by_status", (q) => q.eq("status", status))
      .take(MAX_SAP_PER_STATUS + 1);
    if (rows.length > MAX_SAP_PER_STATUS) truncated = true;
    for (const row of rows.slice(0, MAX_SAP_PER_STATUS)) {
      const kind = sapIssueKind(row, now);
      if (!kind) continue;
      counts[kind]++;
      items.push({
        eventId: row.eventId,
        kind,
        direction: row.direction,
        eventType: row.eventType,
        attempts: row.attempts,
        receivedAt: row.receivedAt,
        documentRef: row.externalDocumentNumber ?? row.sourceDocumentId ?? null,
        lastError: shortError(row.lastError),
      });
    }
  }
  items.sort(
    (a, b) => b.receivedAt - a.receivedAt || a.eventId.localeCompare(b.eventId),
  );
  const heartbeats = await ctx.db.query("connectorHeartbeats").take(20);
  return {
    available: true as const,
    truncated,
    failed: counts.failed,
    deadLetter: counts.dead_letter,
    stuck: counts.stuck,
    connectorsDown: heartbeats
      .filter((row) => connectorDown(row, now))
      .map((row) => ({
        connectorId: row.connectorId,
        status: row.status,
        lastSeenAt: row.lastSeenAt,
      })),
    items: items.slice(0, MAX_LISTED),
  };
}

/** Active inventory locations whose unit is inside the selected scope. */
async function scopedLocations(ctx: QueryCtx, sc: SupervisorContext) {
  const locations: Doc<"inventoryLocations">[] = [];
  let truncated = false;
  for (const unitId of sc.units) {
    if (locations.length >= MAX_LOCATIONS) {
      truncated = true;
      break;
    }
    const rows = await ctx.db
      .query("inventoryLocations")
      .withIndex("by_orgUnitId", (q) => q.eq("orgUnitId", unitId))
      .take(MAX_LOCATIONS - locations.length + 1);
    if (rows.length > MAX_LOCATIONS - locations.length) truncated = true;
    locations.push(
      ...rows
        .slice(0, MAX_LOCATIONS - locations.length)
        .filter(
          (row) =>
            row.active && row.organizationId === SUNPRIDE_ORGANIZATION_ID,
        ),
    );
  }
  return { locations, truncated };
}

async function unclosedTrips(
  ctx: QueryCtx,
  trucks: readonly Doc<"inventoryLocations">[],
  now: number,
) {
  let truncated = false;
  const names = new Map<string, string>();
  const items = [];
  for (const truck of trucks)
    for (const status of UNCLOSED_TRIP_STATUSES) {
      const rows = await ctx.db
        .query("truckRouteSessions")
        .withIndex("by_organizationId_and_truckLocationId_and_status", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("truckLocationId", truck._id)
            .eq("status", status),
        )
        .take(MAX_TRIPS_PER_STATUS + 1);
      if (rows.length > MAX_TRIPS_PER_STATUS) truncated = true;
      for (const trip of rows.slice(0, MAX_TRIPS_PER_STATUS)) {
        if (!tripUnclosed(trip, now)) continue;
        if (!names.has(trip.salespersonSubject))
          names.set(
            trip.salespersonSubject,
            (
              await ctx.db
                .query("profiles")
                .withIndex("by_subject", (q) =>
                  q.eq("authSubject", trip.salespersonSubject),
                )
                .first()
            )?.name ?? "Former user",
          );
        items.push({
          routeSessionId: trip._id,
          routeCode: trip.routeCode,
          truckCode: truck.truckCode ?? truck.code,
          salespersonName: names.get(trip.salespersonSubject)!,
          status: trip.status,
          openedAt: trip.openedAt ?? trip.createdAt,
        });
      }
    }
  items.sort(
    (a, b) => a.openedAt - b.openedAt || a.routeCode.localeCompare(b.routeCode),
  );
  return {
    available: true as const,
    truncated,
    items: items.slice(0, MAX_LISTED),
  };
}

const OPEN_COUNT_STATUSES = ["submitted", "reviewed"] as const;
const SETTLED_COUNT_STATUSES = ["approved", "posted"] as const;

async function stockVariances(
  ctx: QueryCtx,
  sc: SupervisorContext,
  locations: readonly Doc<"inventoryLocations">[],
  locationsTruncated: boolean,
  orgUnitId: Id<"orgUnits"> | undefined,
  start: number,
  end: number,
) {
  let truncated = locationsTruncated;
  const counts = [];
  let blindWithheld = 0;
  // Blind-count separation (inventory/counts.ts detail): whoever created or counted a blind
  // count never sees its expected stock, so its variance and signs are withheld from them.
  const reader = (await ctx.auth.getUserIdentity())?.tokenIdentifier ?? null;
  for (const location of locations)
    for (const status of [...OPEN_COUNT_STATUSES, ...SETTLED_COUNT_STATUSES]) {
      const sessions = await ctx.db
        .query("stockCountSessions")
        .withIndex("by_organizationId_and_locationId_and_status", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("locationId", location._id)
            .eq("status", status),
        )
        .order("desc")
        .take(MAX_COUNTS_PER_STATUS + 1);
      if (sessions.length > MAX_COUNTS_PER_STATUS) truncated = true;
      const open = (OPEN_COUNT_STATUSES as readonly string[]).includes(status);
      for (const session of sessions.slice(0, MAX_COUNTS_PER_STATUS)) {
        // Open counts are listed whatever their date; settled ones only inside the period.
        if (!open && (session.snapshotAt < start || session.snapshotAt >= end))
          continue;
        const lines = await ctx.db
          .query("stockCountLines")
          .withIndex("by_organizationId_and_sessionId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("sessionId", session._id),
          )
          .take(MAX_COUNT_LINES + 1);
        if (lines.length > MAX_COUNT_LINES) truncated = true;
        if (
          session.blindCount &&
          (!reader ||
            session.createdBy === reader ||
            // Unread lines could hide the reader's own count: withhold conservatively.
            lines.length > MAX_COUNT_LINES ||
            lines.some((line) => line.countedBy === reader))
        ) {
          blindWithheld++;
          continue;
        }
        const varied = lines
          .slice(0, MAX_COUNT_LINES)
          .filter(
            (line) =>
              line.varianceBase !== undefined && line.varianceBase !== 0n,
          );
        if (varied.length === 0) continue;
        counts.push({
          sessionId: session._id,
          countNumber: session.countNumber,
          countType: session.countType,
          status: session.status,
          open,
          locationCode: location.code,
          locationName: location.name,
          snapshotAt: session.snapshotAt,
          varianceLines: varied.length,
          missingLines: varied.filter((line) => line.varianceBase! < 0n).length,
          overLines: varied.filter((line) => line.varianceBase! > 0n).length,
        });
      }
    }
  counts.sort(
    (a, b) => Number(b.open) - Number(a.open) || b.snapshotAt - a.snapshotAt,
  );

  // Open SAP reconciliation differences: by location scope; unmapped only nationally.
  const national = await nationalView(ctx, sc, orgUnitId, ["admin", "analyst"]);
  const differences = await ctx.db
    .query("inventoryReconciliationDifferences")
    .withIndex("by_organizationId_and_resolutionStatus_and_createdAt", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("resolutionStatus", "open"),
    )
    .order("desc")
    .take(MAX_DIFFERENCES + 1);
  if (differences.length > MAX_DIFFERENCES) truncated = true;
  const byClassification = new Map<string, number>();
  let unmappedHidden = false;
  let open = 0;
  for (const row of differences.slice(0, MAX_DIFFERENCES)) {
    // Mapping failures have no trusted location boundary: national readers only.
    const location = row.locationId ? await ctx.db.get(row.locationId) : null;
    const unitId = location?.orgUnitId;
    const visible = unitId ? sc.units.has(unitId) : national;
    if (!unitId && !national) unmappedHidden = true;
    if (!visible) continue;
    open++;
    byClassification.set(
      row.classification,
      (byClassification.get(row.classification) ?? 0) + 1,
    );
  }
  return {
    available: true as const,
    truncated,
    counts: counts.slice(0, MAX_LISTED),
    blindWithheld,
    sapDifferences: {
      open,
      byClassification: [...byClassification.entries()]
        .map(([classification, count]) => ({ classification, count }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            a.classification.localeCompare(b.classification),
        ),
      unmappedHidden,
    },
  };
}

/**
 * SAP failures, unclosed van trips and stock variances for the scope. Cash variances need
 * a recorded remittance to compare against collections; none exists yet, so the section
 * says so instead of showing an invented zero.
 */
export const operations = query({
  args: periodArgs,
  returns: v.object({
    from: v.string(),
    to: v.string(),
    sap: sapSection,
    trips: tripsSection,
    stock: stockSection,
    cash: v.object({ tracked: v.literal(false), reason: v.string() }),
  }),
  handler: async (ctx, args) => {
    const { sc } = await context(ctx, args);
    const now = Date.now();
    const noInventory = {
      available: false as const,
      reason: "Needs inventory read access",
    };
    let trips: typeof tripsSection.type = noInventory;
    let stock: typeof stockSection.type = noInventory;
    if (holds(sc, "inventory.read")) {
      const { locations, truncated } = await scopedLocations(ctx, sc);
      const tripResult = await unclosedTrips(
        ctx,
        locations.filter((row) => row.type === "truck"),
        now,
      );
      trips = { ...tripResult, truncated: tripResult.truncated || truncated };
      stock = await stockVariances(
        ctx,
        sc,
        locations,
        truncated,
        args.orgUnitId,
        localDate(args.from),
        localDate(args.to) + DAY_MS,
      );
    }
    return {
      from: args.from,
      to: args.to,
      sap: await sapIssues(ctx, sc, args.orgUnitId, now),
      trips,
      stock,
      cash: {
        tracked: false as const,
        reason:
          "Not available yet: the field apps do not record cash collected and there is no record of cash handed in, so there is nothing to compare. Waiting for Sunpride's cash reconciliation documents.",
      },
    };
  },
});

// ---------------------------------------------------------------------------------------
// Out-of-stock hotspots.

/**
 * Outlets and products repeatedly found out of stock in merchandising audits of the
 * period, plus the units with the most findings. Only `out_of_stock` counts (not
 * `low_stock` or `not_carried`).
 */
export const outOfStock = query({
  args: periodArgs,
  returns: v.object({
    from: v.string(),
    to: v.string(),
    truncated: v.boolean(),
    findings: v.number(),
    outletsAffected: v.number(),
    outlets: v.array(
      v.object({
        outletId: v.id("outlets"),
        outletCode: v.string(),
        outletName: v.string(),
        findings: v.number(),
        products: v.number(),
        lastDate: v.string(),
      }),
    ),
    products: v.array(
      v.object({
        productId: v.id("products"),
        productCode: v.string(),
        productName: v.string(),
        outlets: v.number(),
        findings: v.number(),
      }),
    ),
    units: v.array(
      v.object({
        orgUnitId: v.id("orgUnits"),
        name: v.string(),
        findings: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const { sc } = await context(ctx, args);
    const outletAllowed = currentOutletGate(ctx, sc);
    const findings: OosFinding[] = [];
    let read = 0;
    let truncated = false;
    for (const unitId of sc.units) {
      if (read >= MAX_AVAILABILITY) {
        truncated = true;
        break;
      }
      const rows = await ctx.db
        .query("merchandisingAvailability")
        .withIndex("by_orgUnitId_and_serviceDate", (q) =>
          q
            .eq("orgUnitId", unitId)
            .gte("serviceDate", args.from)
            .lte("serviceDate", args.to),
        )
        .take(MAX_AVAILABILITY - read + 1);
      const room = MAX_AVAILABILITY - read;
      if (rows.length > room) truncated = true;
      read += Math.min(rows.length, room);
      for (const row of rows.slice(0, room))
        if (
          row.status === "out_of_stock" &&
          (await outletAllowed(row.outletId))
        )
          findings.push({
            outletId: row.outletId,
            productId: row.productId,
            orgUnitId: row.orgUnitId,
            serviceDate: row.serviceDate,
          });
    }
    const hot = oosHotspots(findings);
    const outlets = [];
    for (const row of hot.outlets.slice(0, MAX_LISTED)) {
      const outlet = await ctx.db.get(row.outletId as Id<"outlets">);
      outlets.push({
        ...row,
        outletId: row.outletId as Id<"outlets">,
        outletCode: outlet?.code ?? "—",
        outletName: outlet?.name ?? "Unknown outlet",
      });
    }
    const products = [];
    for (const row of hot.products.slice(0, MAX_LISTED)) {
      const product = await ctx.db.get(row.productId as Id<"products">);
      products.push({
        ...row,
        productId: row.productId as Id<"products">,
        productCode: product?.code ?? "—",
        productName: product?.name ?? "Unknown product",
      });
    }
    const unitNames = new Map(
      sc.unitOptions.map((unit) => [unit.id as string, unit.name]),
    );
    const byUnit = new Map<string, number>();
    for (const row of findings)
      byUnit.set(row.orgUnitId, (byUnit.get(row.orgUnitId) ?? 0) + 1);
    return {
      from: args.from,
      to: args.to,
      truncated,
      findings: findings.length,
      outletsAffected: new Set(findings.map((row) => row.outletId)).size,
      outlets,
      products,
      units: [...byUnit.entries()]
        .map(([id, count]) => ({
          orgUnitId: id as Id<"orgUnits">,
          name: unitNames.get(id) ?? "Unit",
          findings: count,
        }))
        .sort((a, b) => b.findings - a.findings || a.name.localeCompare(b.name))
        .slice(0, MAX_LISTED),
    };
  },
});
