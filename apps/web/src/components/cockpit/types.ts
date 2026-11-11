/**
 * DTOs of the management-read contract, `docs/architecture/ANALYTICS_V2.md` §0–§1.
 * Field names are the contract's, unchanged. Money is integer centavos, percentages
 * are 0–100 with one decimal, instants are epoch ms, dates are Manila `YYYY-MM-DD`.
 */

export type KpiUnit = "php" | "pct" | "count" | "cases" | "minutes";
export type KpiStatus = "ok" | "watch" | "behind" | "unknown";

export type Kpi = {
  key: string;
  label: string;
  value: number | null;
  unit: KpiUnit;
  target: number | null;
  prior: number | null;
  deltaPct: number | null;
  status: KpiStatus;
  definition: string;
};

export type ResponseHeader = {
  period: {
    from: string;
    to: string;
    days: number;
    elapsedDays: number;
    remainingSellingDays: number;
  };
  compare: { from: string; to: string };
  scope: { unitId: string | null; label: string };
  freshness: {
    asOf: number;
    devicesBehind: number;
    oldestDeviceSyncAt: number | null;
  };
  demo: boolean;
};

export const EXCEPTION_KINDS = [
  "behind_target",
  "missed_stops",
  "not_started",
  "idle_agent",
  "location_issue",
  "van_unclosed",
  "cash_variance",
  "stock_variance",
  "oos_hotspot",
  "credit_breach",
  "order_approval",
  "mcp_approval",
  "talk_sheet_overdue",
  "per_diem_review",
  "new_store",
  "dormant_key_store",
  "dormant_store",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
export type Severity = "high" | "medium" | "low";

export type ExceptionItem = {
  id: string;
  kind: ExceptionKind;
  severity: Severity;
  title: string;
  detail: string;
  subject: {
    type: "agent" | "store" | "van" | "sku" | "territory" | "order";
    id: string;
    label: string;
  };
  owner: { profileId: string; name: string } | null;
  dueAt: number | null;
  openedAt: number;
  evidence: Record<string, unknown>;
  action: { label: string; href: string };
};

// ---------- /analytics/today ----------
export type FieldStatus =
  "no_plan" | "not_started" | "in_call" | "done" | "idle";
export type VanStatus =
  "loading" | "on_route" | "returned" | "settled" | "unclosed";

export type TodayResponse = ResponseHeader & {
  kpis: Kpi[];
  byChannel: Array<{
    channel: string;
    label: string;
    sales: number;
    target: number | null;
    attainmentPct: number | null;
    status: KpiStatus;
  }>;
  field: {
    counts: {
      noPlan: number;
      notStarted: number;
      inCall: number;
      done: number;
      idle: number;
    };
    people: Array<{
      profileId: string;
      name: string;
      territory: string;
      status: FieldStatus;
      lastSeenAt: number | null;
      planned: number;
      visited: number;
      productive: number;
      sales: number;
    }>;
  };
  vans: Array<{
    tripId: string;
    truck: string;
    seller: string;
    status: VanStatus;
    salesCentavos: number;
    cashExpected: number;
    cashRemitted: number | null;
    variance: number | null;
  }>;
  exceptions: ExceptionItem[];
  trend: Array<{ date: string; sales: number; target: number | null }>;
};

// ---------- /analytics/sales ----------
export type SalesGroupBy =
  "channel" | "territory" | "agent" | "category" | "sku" | "store";

export type SalesRow = {
  key: string;
  label: string;
  sales: number;
  target: number | null;
  attainmentPct: number | null;
  prior: number | null;
  deltaPct: number | null;
  orders: number;
  dropSize: number | null;
  ubo: number;
  status: KpiStatus;
  drill: { groupBy: SalesGroupBy; parent: string } | null;
};

export type SalesResponse = ResponseHeader & {
  kpis: Kpi[];
  stages: { booked: number; approved: number; posted: number };
  trend: Array<{
    date: string;
    sales: number;
    cumSales: number;
    cumTarget: number | null;
    cumPrior: number | null;
  }>;
  rows: SalesRow[];
};

// ---------- /analytics/coverage ----------
export type CoverageRow = {
  key: string;
  label: string;
  planned: number;
  visited: number;
  compliancePct: number | null;
  missed: number;
  offPlan: number;
  productive: number;
  productiveRatePct?: number | null;
  orderCalls?: number;
  strikeRatePct: number | null;
  productiveCallPct?: number | null;
  dwellMin?: number | null;
  dropSize?: number | null;
  rank?: number;
  distributionGained?: number | null;
  linesPerCall: number | null;
  firstCallAt: number | null;
  lastCallAt: number | null;
  timeInMarketMin: number | null;
  workWith: { done: number; required: number | null };
  weekly: Array<number | null>;
  status: KpiStatus;
};

export type CoverageResponse = ResponseHeader & {
  availability?: import("../availability/types").RetailAvailability;
  productivityTrend?: Array<{
    date: string;
    strikeRatePct: number | null;
    productiveCallPct: number | null;
    dwellMin: number | null;
  }>;
  kpis: Kpi[];
  weeks: Array<{ weekStart: string }>;
  rows: CoverageRow[];
};

// ---------- /analytics/agent-day ----------
export type TimelineKind =
  "check_in" | "check_out" | "order" | "collection" | "activity" | "gap";

export type AgentDayResponse = ResponseHeader & {
  person: {
    profileId: string;
    name: string;
    territory: string;
    position: string;
  };
  summary: {
    planned: number;
    visited: number;
    productive: number;
    sales: number;
    firstCallAt: number | null;
    lastCallAt: number | null;
    distanceKm: number | null;
  };
  timeline: Array<{
    at: number;
    kind: TimelineKind;
    storeId: string | null;
    storeLabel: string | null;
    detail: string;
    amountCentavos: number | null;
    onPlan: boolean | null;
  }>;
  trail: Array<{ at: number; lat: number; lng: number }>;
};

// ---------- /analytics/stores ----------
export type StoreStatus = "active" | "dormant" | "new" | "lost" | "never";

export type StoreRow = {
  storeId: string;
  code: string;
  name: string;
  channel: string;
  territory: string;
  status: StoreStatus;
  salesPeriod: number;
  salesPrior: number | null;
  deltaPct: number | null;
  lastOrderAt: number | null;
  lastVisitAt: number | null;
  skuCount: number;
  mustSellGaps: number;
  arBalance: number | null;
};

export type StoresResponse = ResponseHeader & {
  kpis: Kpi[];
  uboTrend: Array<{ weekStart: string; ubo: number }>;
  rows: StoreRow[];
  next: string | null;
  /** Rows matching the search + status filter (all pages). */
  total?: number;
  page?: number;
  /** Per-status counts for the current search. */
  matches?: Partial<Record<StoreStatus | "all", number>>;
};

// ---------- /analytics/store ----------
export type StoreResponse = ResponseHeader & {
  context?: import("./pages/tower").OutletContext;
  store: {
    storeId: string;
    code: string;
    name: string;
    channel: string;
    territory: string;
    agent?: string | null;
    address?: string | null;
    status?: StoreStatus;
    creditLimit?: number | null;
    [field: string]: unknown;
  };
  kpis: Kpi[];
  salesTrend: Array<{ weekStart: string; sales: number }>;
  visits: Array<{
    at: number;
    agent: string;
    productive: boolean;
    outcome: string;
    onPlan: boolean | null;
  }>;
  orders: Array<{
    orderId: string;
    number: string;
    at: number;
    status: string;
    totalCentavos: number;
    lines: number;
  }>;
  assortment: Array<{
    productId: string;
    code: string;
    name: string;
    lastBoughtAt: number | null;
    onShelf: boolean | null;
  }>;
  suggestedOrder: Array<{
    productId: string;
    qtyCases: number;
    quantityDisplay?: string;
    reason: string;
  }>;
};

// ---------- /analytics/stock ----------
export type StockRow = {
  productId: string;
  code: string;
  name: string;
  category: string;
  onHand: { cases: number; pieces: number; display: string };
  valueCentavos: number | null;
  /** IP-INT2: from /inventory/valuation. Unknown price stays null; `costKnown` false means the value above is not real cost. */
  sellingValueCentavos?: number | null;
  costKnown?: boolean;
  avgDailySalesCases: number | null;
  daysCover: number | null;
  numericDistributionPct: number | null;
  buyingReachPct?: number | null;
  weightedDistributionPct?: number | null;
  unmeasuredStores?: number;
  oosStores: number;
  status: string;
};

export type StockResponse = ResponseHeader & {
  kpis: Kpi[];
  locations: Array<{
    locationId: string;
    label: string;
    kind: "depot" | "truck" | "other";
    valueCentavos: number | null;
    cases: number;
  }>;
  rows: StockRow[];
};

// ---------- /inventory/valuation (IP-VALUE; the stock page's source of truth for quantity and value) ----------
export type ValuationQty = {
  base: number;
  cases: number | null;
  pieces: number | null;
  display: string;
  valueCentavos: number | null;
};
export type ValuationRow = {
  productId: string;
  code: string;
  name: string;
  category: string | null;
  locationId: string;
  locationName?: string;
  onHand: ValuationQty;
  available: ValuationQty;
  units?: { basePerCase: number | null };
  costValueCentavos: number;
  costKnown: boolean;
  sellingValueCentavos: number | null;
};
export type ValuationResponse = {
  asOf: number;
  basis: "cost" | "selling";
  groupBy: "product" | "lot";
  valueLabel: string;
  secondaryValueLabel: string;
  rows: ValuationRow[];
  totals: {
    costValueCentavos: number | null;
    sellingValueCentavos: number | null;
    rowsWithoutCost: number;
    rowsWithoutPrice: number;
  };
};

// ---------- /analytics/vans ----------
export type VanRow = {
  tripId: string;
  truck: string;
  seller: string;
  status: VanStatus;
  loadedCases: number;
  soldCases: number;
  returnedCases: number | null;
  customerReturnedCases?: number | null;
  customerReturns?: Array<{
    name: string;
    quantity: { cases: number | null; pieces: number | null; display: string };
  }>;
  stockVarianceCases: number | null;
  salesCentavos: number;
  cashExpected: number;
  cashRemitted: number | null;
  variance: number | null;
  voids: number;
  discountsCentavos: number;
  closedAt: number | null;
};

export type VansResponse = ResponseHeader & { kpis: Kpi[]; rows: VanRow[] };

// ---------- /analytics/money ----------
export type MoneyRow = {
  accountId: string;
  code: string;
  name: string;
  channel: string;
  agent: string | null;
  balance: number;
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90p: number;
  creditLimit: number | null;
  lastPaymentAt: number | null;
  status: string;
};

export type MoneyResponse = ResponseHeader & {
  kpis: Kpi[];
  aging: {
    current: number;
    d1_30: number;
    d31_60: number;
    d61_90: number;
    d90p: number;
  };
  rows: MoneyRow[];
};

// ---------- /analytics/exceptions ----------
export type ExceptionsResponse = ResponseHeader & {
  counts: Partial<Record<ExceptionKind, number>>;
  items: ExceptionItem[];
  next: string | null;
};

// ---------- /targets ----------
export type TargetLevel = "company" | "channel" | "territory" | "agent";
export type TargetsResponse = {
  month: string;
  level: TargetLevel;
  /** False when the caller's scope cannot write this level (server-checked on save too). */
  editable?: boolean;
  rows: Array<{
    key: string;
    label: string;
    amountCentavos: number | null;
    setBy: string | null;
    setAt: number | null;
  }>;
  total: number;
};

export type AnalyticsPage =
  | "today"
  | "sales"
  | "coverage"
  | "agent-day"
  | "stores"
  | "store"
  | "stock"
  | "vans"
  | "money"
  | "exceptions";

export type AnalyticsResponses = {
  today: TodayResponse;
  sales: SalesResponse;
  coverage: CoverageResponse;
  "agent-day": AgentDayResponse;
  stores: StoresResponse;
  store: StoreResponse;
  stock: StockResponse;
  vans: VansResponse;
  money: MoneyResponse;
  exceptions: ExceptionsResponse;
};
