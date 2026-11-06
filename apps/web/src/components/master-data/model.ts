// Bun API DTOs. IDs are plain UUID transport strings.
export type Id<Table extends string> = Table extends string ? string : never;
export type Role =
  | "super_admin"
  | "admin"
  | "operations"
  | "manager"
  | "approver"
  | "sales"
  | "analyst"
  | "viewer";
export type Base = { _id: string; id?: string; _creationTime?: number };
export type Window = { effectiveFrom: number; effectiveTo?: number };
export type Unit = Base &
  Window & {
    code: string;
    name: string;
    typeCode: string;
    parentId?: string;
    status: "active" | "inactive";
    organizationId?: string;
  };
export type Person = Base & {
  name: string;
  email: string;
  authSubject: string;
  userId?: string;
  role: Role;
  status: "active" | "disabled";
  orgUnitId?: string;
  employeeCode?: string;
  phone?: string;
  positionId?: string;
  supervisorSubject?: string;
  effectiveFrom?: number;
  updatedAt?: number;
};
export type Position = Base & {
  code: string;
  label: string;
  category: string;
  active: boolean;
};
export type Territory = Base &
  Window & {
    code: string;
    name: string;
    channel?: string;
    boundaryGeoJson?: string;
    status: "active" | "inactive";
  };
export type Route = Base &
  Window & {
    code: string;
    name: string;
    weekdayTemplate?: number[];
    cycleDays?: number;
    status: "active" | "inactive";
  };
export type History = Base &
  Window & {
    orgUnitId?: string;
    orgUnitName?: string;
    profileId: string;
    personName?: string;
    actorSubject: string;
    actorName?: string;
    reason: string;
    role: Role;
    positionId?: string;
    supervisorId?: string;
    territoryId: string;
    territoryName?: string;
    routeId?: string;
    routeName?: string;
    outletId: string;
    outletName?: string;
    sequence?: number;
    kind?: "primary" | "secondary";
    primary?: boolean;
    source?: string;
    customerId: string;
    customerName?: string;
  };
export type Pin = Base &
  Window & {
    outletId: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    source: string;
    evidenceNote?: string;
    status: "pending" | "verified" | "rejected" | "superseded";
    proposedBy: string;
    proposerName?: string;
    verifiedBy?: string;
    verifierName?: string;
    reviewerReason?: string;
  };
export type Outlet = Base & {
  code: string;
  name: string;
  status: "active" | "inactive" | "prospect";
  enrolmentStatus?: "provisional" | "approved" | "rejected";
  custodianOrgUnitId: string;
  channel?: string;
  subchannel?: string;
  classification?: string;
  address?: string;
  directions?: string;
  contacts?: { name: string; phone?: string }[];
  salesPotential?: number;
  preferredWeekday?: number;
  visitFrequencyDays?: number;
  visitWindow?: string;
  territoryName?: string;
  territoryCode?: string;
  routeName?: string;
  routeCode?: string;
  creditLimitCentavos?: number;
};
export type Team = Base &
  Window & {
    code: string;
    name: string;
    orgUnitId: string;
    status: "active" | "inactive";
  };
export type Customer = Base & {
  code: string;
  name: string;
  channel: string;
  territory: string;
  creditLimitCentavos: number;
  active: boolean;
};
export type Standard = Base &
  Window & {
    dailyCallsTarget?: number;
    productiveCallTargetPct?: number;
    workWithWeeklyMin?: number;
    workWithMonthlyMin?: number;
    productiveCallRule?: string;
    sellingWeekdays?: number[];
    notes?: string;
    sourceRef: string;
  };
export type Invitation = Base & {
  name?: string;
  email: string;
  role: Role;
  orgUnitId?: string;
  positionId?: string;
  status: "pending" | "accepted" | "revoked";
};
export type Device = {
  deviceId: string;
  inventoryTag: string;
  employeeName: string | null;
  status: "active" | "suspended" | "revoked";
  model: string;
  platform: string;
  allowedApp?: string;
  osVersion?: string;
  appVersion?: string;
  lastSeenAt: number | null;
  statusReason?: string;
  statusAt: number | null;
  offlineLeaseExpiresAt: number | null;
};
export type DeviceReport = {
  device: Device;
  lastAcknowledgedAt: number | null;
  acknowledged: { kind: string; clientRequestId: string; serverAt: number }[];
  acknowledgedMore: boolean;
  history: {
    action: string;
    at: number;
    actorName: string | null;
    reason: string | null;
  }[];
};
export type Enrolment = Base & {
  outletId: string;
  proposedByProfileId: string;
  proposedBy: string;
  proposedAt: number;
  status: "pending" | "approved" | "rejected";
  decisionReason?: string;
};
export type EnrolmentItem = {
  enrolment: Enrolment;
  outlet: Outlet;
  pin: Pin | null;
  proposerName: string;
  photoUrls: string[];
  cisUrl: string | null;
};
export type Page<T> = {
  page: T[];
  next?: string | null;
  continueCursor: string;
  isDone: boolean;
};
export type PageInput = {
  paginationOpts?: { numItems: number; cursor: string | null };
  q?: string;
  search?: string;
  limit?: number;
  cursor?: string | null;
  asOf?: number;
  status?: string;
  unassigned?: string;
};
export type Permissions = {
  capabilities: string[];
  role: Role;
  scopeUnitIds: string[];
  national?: boolean;
};
export type Health = {
  asOf: number;
  comparisonNote: string;
  items: {
    key: string;
    label: string;
    count: number | null;
    atLeast?: number;
    target: number;
    prior: number | null;
    trend: number[];
    fix: string;
    href: string;
  }[];
};
export type Product = Base & {
  code: string;
  name: string;
  category: string;
  uom: string;
  baseUomId?: string;
  quantityScale?: number | string;
  active: boolean;
  uomDisplay: string;
  priceStatus: string;
  conversions: {
    fromCode: string;
    toCode: string;
    numerator: string | number;
    denominator: string | number;
  }[];
};
export type Documents = {
  profiles: Person;
  orgUnits: Unit;
  territories: Territory;
  routes: Route;
  outlets: Outlet;
  outletPins: Pin;
};
export type Doc<T extends keyof Documents> = Documents[T];
export type ReadMap = {
  "org/tree": Unit[];
  "org/types": (Base & { code: string; label: string; level: number })[];
  "org/permissions": Permissions;
  "org/setup-health": Health;
  "people/current": Person | null;
  "people/list": Page<Person>;
  "people/supervisor-options": Page<Person>;
  "people/history": History[];
  "people/invitations/list": Page<Invitation>;
  "org/teams/list": Page<Team>;
  "org/teams/detail": {
    team: Team;
    members: { membership: History; profile: Person }[];
  };
  "org/teams/member-history": History[];
  "territories/list": Page<Territory>;
  "territories/detail": { territory: Territory; owner: History | null };
  "territories/salespeople-at": History[];
  "territories/ownership-history": History[];
  "territories/routes/list": Page<Route>;
  "territories/routes/detail": {
    route: Route;
    territory: History | null;
    salespeople: History[];
  };
  "territories/routes/history": {
    territories: History[];
    salespeople: History[];
  };
  "outlets/list": Page<Outlet>;
  "outlets/detail": {
    outlet: Outlet;
    customerLink: History | null;
    assignment: History | null;
    pin: Pin | null;
  };
  "outlets/customer-history": History[];
  "outlets/pin-history": Pin[];
  "outlets/unassigned": Page<Outlet>;
  "outlets/assignments/history": History[];
  "outlets/assignments/route-stops": History[];
  "outlets/assignments/territory-roster": History[];
  "outlets/pins/queue": Page<Pin & { outlet: Outlet }>;
  "outlets/enrolment/pending": Page<EnrolmentItem>;
  "outlets/enrolment/mine": Page<EnrolmentItem>;
  "outlets/enrolment/notifications": (Base & {
    kind: "proposed" | "approved" | "rejected";
    outletName: string;
    outletCode: string;
    actorName: string;
    createdAt: number;
    reason?: string;
  })[];
  "outlets/enrolment/code-format": {
    prefix: string;
    digits: number;
    example: string;
  };
  "people/devices/list": Page<Device>;
  "people/devices/report": DeviceReport;
  "catalog/customers/list": Page<Customer>;
  "catalog/products/list": Page<Product>;
  "catalog/uoms": (Base & {
    code: string;
    name: string;
    dimension: string;
    decimalPlaces: number;
  })[];
  "catalog/positions": Position[];
  "catalog/standards": {
    definition: {
      rules: { code: string; label: string }[];
      activities: { code: string; label: string }[];
      defaultSellingWeekdays: number[];
      ruleVersion: string;
    };
    positions: {
      positionId: string;
      label: string;
      code: string;
      standard: Standard | null;
    }[];
  };
};
export type AssignmentChoice = {
  outletId: string;
  territoryId: string;
  routeId?: string;
  sequence?: number;
};
type Reason = { reason: string };
type Future = Reason & { effectiveFrom: number };
type End = Reason & { effectiveTo: number };
type OutletProfile = {
  name: string;
  status?: "prospect" | "active";
  channel?: string;
  subchannel?: string;
  classification?: string;
  address?: string;
  directions?: string;
  salesPotential?: number;
  preferredWeekday?: number;
  visitFrequencyDays?: number;
  visitWindow?: string;
  contacts?: { name: string; phone?: string }[];
};
export type CommandMap = {
  "org/create": Future & {
    parentId: string;
    code: string;
    name: string;
    typeCode: string;
  };
  "org/edit": Reason & { unitId: string; name: string };
  "org/reparent": Future & { unitId: string; parentId: string };
  "org/deactivate": End & { unitId: string };
  "people/assign": Reason & {
    profileId: string;
    orgUnitId: string;
    role: Exclude<Role, "super_admin">;
    positionId?: string;
    supervisorId?: string;
    employeeCode?: string;
    phone?: string | null;
  };
  "people/invite": {
    email: string;
    name?: string;
    role: Exclude<Role, "super_admin">;
    positionId?: string;
    orgUnitId?: string;
  };
  "people/revoke": { invitationId: string };
  "org/teams/create": Future & {
    code: string;
    name: string;
    orgUnitId: string;
  };
  "org/teams/addMember": Future & { teamId: string; profileId: string };
  "org/teams/removeMember": End & { teamId: string; profileId: string };
  "org/teams/deactivate": End & { teamId: string };
  "territories/create": Future & {
    code: string;
    name: string;
    orgUnitId: string;
    channel?: string;
    boundaryGeoJson?: string;
    effectiveTo?: number;
  };
  "territories/edit": Reason & {
    territoryId: string;
    name: string;
    channel?: string;
    boundaryGeoJson?: string;
  };
  "territories/transferOwner": Future & {
    territoryId: string;
    orgUnitId: string;
  };
  "territories/assignSalesperson": Future & {
    territoryId: string;
    profileId: string;
    kind?: "primary" | "secondary";
  };
  "territories/endSalespersonAssignment": End & { assignmentId: string };
  "territories/deactivate": End & { territoryId: string };
  "territories/routes/create": Future & {
    territoryId: string;
    code: string;
    name: string;
    effectiveTo?: number;
    weekdayTemplate?: number[];
    cycleDays?: number;
  };
  "territories/routes/edit": Reason & {
    routeId: string;
    name: string;
    weekdayTemplate?: number[];
    cycleDays?: number;
  };
  "territories/routes/move": Future & { routeId: string; territoryId: string };
  "territories/routes/duplicateTemplate": Future & {
    routeId: string;
    territoryId: string;
    code: string;
    name: string;
  };
  "territories/routes/assignSalesperson": Future & {
    routeId: string;
    profileId: string;
    primary: boolean;
  };
  "territories/routes/endSalespersonAssignment": End & { assignmentId: string };
  "territories/routes/deactivate": End & { routeId: string };
  "outlets/create": Reason &
    OutletProfile & { code: string; custodianOrgUnitId: string };
  "outlets/edit": Reason & OutletProfile & { outletId: string };
  "outlets/deactivate": Reason & { outletId: string };
  "outlets/changeCustomerLink": Future & {
    outletId: string;
    customerId?: string;
    source: string;
  };
  "outlets/pins/propose": Reason & {
    outletId: string;
    latitude: number;
    longitude: number;
    radiusMeters?: number;
    source: string;
    evidenceNote?: string;
    effectiveFrom?: number;
  };
  "outlets/pins/decide": Reason & {
    pinId: string;
    decision: "verified" | "rejected";
  };
  "outlets/assignments/assign": Future & AssignmentChoice;
  "outlets/assignments/batchAssign": Future & {
    assignments: AssignmentChoice[];
  };
  "outlets/assignments/reorder": Future & {
    routeId: string;
    outletIds: string[];
  };
  "outlets/enrolment/decide": Reason & {
    enrolmentId: string;
    decision: "approved" | "rejected";
  };
  "people/devices/suspend": { deviceId: string; reason: string };
  "people/devices/revoke": { deviceId: string; reason: string };
  "people/devices/reinstate": { deviceId: string; reason: string };
  "catalog/saveProduct": Reason & {
    productId?: string;
    code?: string;
    name: string;
    category: string;
    baseUomId: string;
    quantityScale: number;
    active: boolean;
  };
  "catalog/saveCustomer": Reason & {
    customerId?: string;
    code?: string;
    name: string;
    channel: string;
    territory: string;
    creditLimitCentavos: number;
    active: boolean;
  };
};
export type CommandArgs<P extends keyof CommandMap> = CommandMap[P];
export type CommandResult<P extends keyof CommandMap> =
  P extends "outlets/enrolment/decide" ? { code: string } : unknown;
