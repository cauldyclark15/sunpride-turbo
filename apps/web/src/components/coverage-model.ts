// Coverage HTTP DTOs. UUIDs are plain strings; instants are epoch milliseconds.
import type { SchedulePage, ScheduleRow } from "../lib/coverage-export";
import type { McpDeadlineState, ApprovalCapacity } from "../lib/mcp-deadlines";
export type Id<T extends string> = string &
  (T extends string ? unknown : never);
export type Plan = {
  _id: string;
  _creationTime?: number;
  organizationId: string;
  assigneeProfileId: string;
  localMonth: string;
  version: number;
  cycleType: "monthly";
  orgUnitId: string;
  territoryIds: string[];
  requestedFrom: number;
  requestedTo: number;
  effectiveFrom: number;
  effectiveTo: number;
  status: "draft" | "submitted" | "approved" | "active" | "superseded";
  basedOnPlanId?: string;
  revisionReason?: string;
  preparedBy: string;
  preparedAt: number;
  submittedBy?: string;
  submittedAt?: number;
  approvedBy?: string;
  approvedAt?: number;
  approvalSignature?: string;
  contentHash?: string;
  contentRevision: number;
  approverProfileId?: string;
  approvalCapacity?: ApprovalCapacity;
  approvedOnBehalfOfProfileId?: string;
  activatedAt?: number;
  createdBy: string;
  updatedBy: string;
  updatedAt: number;
};
export type OutletInput = {
  outletId: string;
  routeId?: string;
  territoryId: string;
  frequency: "weekly" | "biweekly" | "monthly" | "custom";
  anchorLocalDate?: string;
  weekOrdinal?: number;
  preferredWeekdays: (0 | 1 | 2 | 3 | 4 | 5 | 6)[];
  customLocalDates: string[];
  sequence?: number;
  priority: number;
  expectedDurationMinutes: number;
  requiredObjectives: string[];
  visitWindow?: string;
};
export type Snapshot = {
  outletId: string;
  outletCode: string;
  outletName: string;
  territoryId: string;
  territoryCode: string;
  routeId?: string;
  routeCode?: string;
  customerId?: string;
  customerName?: string;
  customerCode?: string;
  sequence?: number;
  orgUnitId?: string;
};
export type SlotInput = {
  slotKey: string;
  serviceDate: string;
  kind: "outlet_visit" | "non_visit";
  outletId?: string;
  routeId?: string;
  activityKind?: string;
  namedTruckRef?: string;
  requiredObjectives: string[];
  intents: string[];
  sequence: number;
  expectedDurationMinutes: number;
};
export type Slot = SlotInput & {
  _id: string;
  planId: string;
  assigneeProfileId: string;
  approvedSnapshot?: Snapshot;
  contentRevision: number;
  updatedBy: string;
  updatedAt: number;
};
export type Profile = {
  _id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  orgUnitId?: string;
  authSubject: string;
  employeeCode?: string;
};
export type Assignment = {
  _id: string;
  planId: string;
  assigneeProfileId: string;
  orgUnitId: string;
  primary: boolean;
  effectiveFrom: number;
  effectiveTo: number;
  reason: string;
};
export type Audit = {
  _id: string;
  actorSubject: string;
  action: string;
  createdAt: number;
  planVersion: number;
  reason?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  diff?: Record<string, unknown>;
  affectedEntity: string;
  affectedRowId?: string;
  approvalSignatureRef?: string;
};
export type Visit = {
  _id: string;
  planId: string;
  assigneeProfileId: string;
  serviceDate: string;
  status: "planned" | "cancelled" | "replaced";
  approvedSnapshot: Snapshot;
  replacedByVisitId?: string;
  replacementOfVisitId?: string;
  cancellationReason?: string;
};
export type DocMap = {
  coveragePlans: Plan;
  coveragePlanOutlets: OutletInput & {
    _id: string;
    planId: string;
    contentRevision: number;
    updatedBy: string;
    updatedAt: number;
  };
  coveragePlanSlots: Slot;
  coverageAuditEvents: Audit;
  profiles: Profile;
  plannedVisits: Visit;
};
export type Doc<T extends keyof DocMap> = DocMap[T];
export type Page<T> = { page: T[]; continueCursor: string; isDone: boolean };
export type PageArgs = {
  paginationOpts: { numItems: number; cursor: string | null };
};
export type Filters = {
  territoryId?: string;
  routeId?: string;
  visitStatus?: "planned" | "cancelled" | "replaced";
};
export type PlanArgs = { planId: string };
export type Permissions = {
  role: string;
  capabilities: string[];
  scopeUnitIds: string[];
};
export type Attribution = {
  latestReturnReason?: string;
  preparedByName: string;
  submittedByName?: string;
  approvedByName?: string;
  eventsActorNames: Record<string, string>;
};
export type Deadlines = {
  localMonth: string;
  submissionOpensDate: string;
  submissionDueDate: string;
  approvalDueDate: string;
  submissionOpensAt: number;
  submissionDueAt: number;
  approvalDueAt: number;
};
export type DeadlinePerson = {
  profileId: string;
  name: string;
  orgUnitId: string;
  supervisorName?: string;
  planId?: string;
  version?: number;
  planStatus?: Plan["status"];
  state: McpDeadlineState;
  submittedLate: boolean;
  approvedLate: boolean;
  approvalCapacity?: ApprovalCapacity;
};
export type ApprovalView = {
  supervisorName?: string;
  supervisorAway: boolean;
  awayUntilDate?: string;
  backupName?: string;
  backupRule: "recorded_manager" | "scope_above" | "none";
  viewerCapacity?: ApprovalCapacity;
  viewerBlockedReason?: string;
  viewerIsBackupManager: boolean;
  supervisorProfileId?: string;
  approvedCapacity?: ApprovalCapacity;
  approverName?: string;
  onBehalfOfName?: string;
  deadlines: Deadlines;
  deadlineState?: McpDeadlineState;
  submittedLate: boolean;
  approvedLate: boolean;
};
export type Review = {
  daily: { date: string; calls: number; target: number | null }[];
  frequencyGaps: {
    outletId: string;
    name: string;
    expected: number;
    planned: number;
  }[];
  routes: { code: string; stores: number }[];
  standardSource: string | null;
  planned: number;
  visited: number;
  productive: number;
};
export type Detail = {
  plan: Plan;
  outlets: DocMap["coveragePlanOutlets"][];
  slots: Slot[];
  assignments: Assignment[];
  warnings: string[];
  review?: Review;
};
export type Away = {
  _id: string;
  profileId: string;
  effectiveFrom: number;
  effectiveTo: number;
  reason: string;
};
export type Discovery = {
  planId: string;
  assigneeProfileId: string;
  assigneeName: string;
  localMonth: string;
  version: number;
  status: Plan["status"];
};
export type ExceptionRow = {
  code: string;
  severity: "blocking" | "advisory";
  outletId?: string;
  serviceDate?: string;
  message: string;
  remediation: string;
  signedHistorical: boolean;
};
export type RouteRow = {
  territoryId?: string;
  territoryCode: string;
  routeId?: string;
  routeCode: string;
  slotCount: number;
  visitCount: number;
  coveredCount: number;
  uncoveredCount: number;
  outlets: {
    outletCode: string;
    name: string;
    frequency?: string;
    covered: boolean;
  }[];
};
export type Workload = {
  assigneeProfileId: string;
  assigneeName: string;
  planId: string;
  version: number;
  planStatus: Plan["status"];
  selection: string;
  routeCodes: string[];
  visitCount: number;
  workingDays: string[];
  durationMinutes: number;
  dailyCallsTarget?: number;
  variance?: number;
};
export type Pin = {
  outletId: string;
  outletCode: string;
  outletName: string;
  latitude?: number;
  longitude?: number;
  pinStatus: "verified" | "unmapped";
  sequence?: number;
  inPlan: boolean;
  assigned: boolean;
};
export type Summary = {
  month: string;
  deadlines: Deadlines;
  asOf: number;
  counts: Record<
    "not_started" | "draft" | "submitted" | "approved" | "active",
    number
  >;
  lateCount: number;
  awaitingMine: number;
  target: number;
  ready: number;
  priorReady: number;
  priorMonth: string;
  trend: { month: string; ready: number; target: number }[];
  rows: (DeadlinePerson & {
    status: string;
    awaitsMyApproval: boolean;
    approvalPlanId?: string;
    action: { label: string; planId?: string; profileId: string };
  })[];
};
export type Endpoint<A, R> = {
  name: string;
  path: string;
  args?: A;
  result?: R;
};
export type FunctionArgs<T> = T extends Endpoint<infer A, unknown> ? A : never;
export type FunctionReturnType<T> =
  T extends Endpoint<unknown, infer R> ? R : never;
const e = <A, R>(name: string, path: string): Endpoint<A, R> => ({
  name,
  path: `/api/v1/coverage/${path}`,
});
const q = <A, R>(group: string, name: string) =>
  e<A, R>(`coverage/${group}:${name}`, `${group}/${name}`);
const cp = <A, R>(name: string) => q<A, R>("plans", name);
export const api = {
  lib: {
    capabilities: {
      currentPermissions: e<Record<string, never>, Permissions>(
        "lib/capabilities:currentPermissions",
        "permissions",
      ),
    },
  },
  domains: {
    profiles: {
      current: e<Record<string, never>, Profile | null>(
        "domains/profiles:current",
        "profile",
      ),
    },
  },
  people: {
    queries: {
      list: e<PageArgs, Page<Profile>>("people/queries:list", "people"),
    },
  },
  territories: {
    queries: {
      list: e<PageArgs, Page<{ _id: string; code: string; name: string }>>(
        "territories/queries:list",
        "lookup/territories",
      ),
    },
    routes: {
      list: e<
        PageArgs & { territoryId: string },
        Page<{ _id: string; code: string; name: string }>
      >("territories/routes:list", "lookup/routes"),
      detail: e<{ routeId: string; asOf: number }, { route: { code: string } }>(
        "territories/routes:detail",
        "lookup/route",
      ),
    },
  },
  outlets: {
    queries: {
      list: e<PageArgs, Page<{ _id: string; code: string; name: string }>>(
        "outlets/queries:list",
        "lookup/outlets",
      ),
      detail: e<
        { outletId: string; asOf: number },
        {
          outlet: { code: string; name: string };
          assignment?: { routeId?: string; sequence?: number };
          customerLink?: {
            customerId: string;
            customerName?: string;
            customerCode?: string;
          };
        }
      >("outlets/queries:detail", "lookup/outlet"),
    },
    assignments: {
      territoryRoster: e<
        { territoryId: string; asOf: number },
        {
          _id: string;
          outletId: string;
          territoryId: string;
          routeId?: string;
          sequence?: number;
        }[]
      >("outlets/assignments:territoryRoster", "lookup/roster"),
    },
  },
  coverage: {
    summary: e<{ month: string }, Summary>("coverage:summary", "summary"),
    review: e<PlanArgs, Review>("coverage:review", "review"),
    plans: {
      list: cp<{ assigneeProfileId: string; localMonth: string }, Plan[]>(
        "list",
      ),
      detail: cp<PlanArgs, Detail>("detail"),
      create: cp<{ assigneeProfileId: string; localMonth: string }, Plan>(
        "create",
      ),
      createRevision: cp<
        PlanArgs & { effectiveFromDate: string; reason: string },
        Plan
      >("createRevision"),
      saveOutlets: cp<PlanArgs & { outlets: OutletInput[] }, Plan>(
        "saveOutlets",
      ),
      saveSlots: cp<PlanArgs & { slots: SlotInput[] }, Plan>("saveSlots"),
      setAssignment: cp<
        PlanArgs & {
          effectiveFrom: number;
          effectiveTo: number;
          reason: string;
        },
        Plan
      >("setAssignment"),
      submit: cp<PlanArgs, Plan>("submit"),
      returnPlan: cp<PlanArgs & { reason: string }, Plan>("returnPlan"),
      approve: cp<PlanArgs, Plan>("approve"),
    },
    discovery: {
      list: q<
        { localMonth: string; status?: string } & PageArgs,
        Page<Discovery>
      >("discovery", "list"),
      attribution: q<PlanArgs, Attribution>("discovery", "attribution"),
    },
    activation: {
      activate: q<PlanArgs, { visitIds: string[]; count: number }>(
        "activation",
        "activate",
      ),
      plannedForMonth: q<
        { assigneeProfileId: string; localMonth: string },
        Visit[]
      >("activation", "plannedForMonth"),
    },
    routines: {
      listForPosition: q<
        PlanArgs,
        {
          templates: {
            weekday: number;
            dayKind: string;
            sourceRef: string;
            activities: { name: string; sequence: number }[];
          }[];
          warning: string | null;
        }
      >("routines", "listForPosition"),
      applyToDraft: q<PlanArgs, { created: number; warning: string | null }>(
        "routines",
        "applyToDraft",
      ),
    },
    calendar: {
      status: q<
        { localMonth: string; asOf: number } & PageArgs,
        Page<DeadlinePerson> & { deadlines: Deadlines }
      >("calendar", "status"),
      approvalView: q<PlanArgs & { asOf: number }, ApprovalView>(
        "calendar",
        "approvalView",
      ),
    },
    away: {
      list: q<{ profileId: string; asOf: number }, Away[]>("away", "list"),
      record: q<
        { profileId: string; fromDate: string; toDate: string; reason: string },
        Away
      >("away", "record"),
      end: q<{ awayId: string }, Away>("away", "end"),
    },
    history: { list: q<PlanArgs & PageArgs, Page<Audit>>("history", "list") },
    views: {
      filterOptions: q<
        PlanArgs,
        {
          territories: { id: string; code: string; name: string }[];
          routes: { id: string; code: string; name: string }[];
        }
      >("views", "filterOptions"),
      calendar: q<
        PlanArgs & PageArgs & Filters,
        Page<ScheduleRow & { planStatus: Plan["status"] }>
      >("views", "calendar"),
      byRoute: q<PlanArgs & PageArgs, Page<RouteRow>>("views", "byRoute"),
      workload: q<
        { localMonth: string; planId?: string } & PageArgs & Filters,
        Page<Workload>
      >("views", "workload"),
    },
    map: {
      forPlan: q<PlanArgs & PageArgs & Filters, Page<Pin>>("map", "forPlan"),
    },
    exceptions: {
      forPlan: q<PlanArgs & PageArgs, Page<ExceptionRow>>(
        "exceptions",
        "forPlan",
      ),
    },
    exports: {
      schedule: q<PlanArgs & PageArgs & Filters, SchedulePage>(
        "exports",
        "schedule",
      ),
    },
  },
};
export const getFunctionName = (ref: { name: string }) => ref.name;
