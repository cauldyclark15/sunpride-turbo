/**
 * Dev and test fixtures that follow ANALYTICS_V2 §0–§1 exactly. One small
 * deterministic "demo company" (Sunpride Cebu: 4 territories, 14 field people,
 * 5 channels, 40 SKUs, 312 stores, 2 vans) produces every page, so Today,
 * Sales and the drill rows reconcile to the centavo the way the server must.
 * Loaded only in fixture mode (dev) and by tests; never in production.
 */
import type {
  AgentDayResponse,
  AnalyticsPage,
  AnalyticsResponses,
  CoverageResponse,
  ExceptionItem,
  ExceptionsResponse,
  Kpi,
  KpiStatus,
  KpiUnit,
  MoneyResponse,
  ResponseHeader,
  SalesGroupBy,
  SalesResponse,
  SalesRow,
  StockResponse,
  ValuationResponse,
  StoreResponse,
  StoreRow,
  StoreStatus,
  StoresResponse,
  TargetLevel,
  TargetsResponse,
  TodayResponse,
  VansResponse,
} from "./types";
import type { UnitOption } from "./api";
import { formatPhp } from "./format";
import {
  addDays,
  channelLabel,
  CHANNELS,
  daysBetween,
  isIsoDate,
  manilaToday,
  presetRange,
} from "./period";

type Query = Record<string, string>;

// ---------- deterministic noise ----------
function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** 0 ≤ n < 1, stable per seed. */
function noise(seed: string) {
  let t = hash(seed) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const pctOf = (part: number, whole: number) =>
  whole > 0 ? round1((part / whole) * 100) : null;

/** Manila instant for a date and clock time. */
function at(date: string, hh: number, mm = 0) {
  return Date.parse(`${date}T00:00:00+08:00`) + (hh * 60 + mm) * 60_000;
}

// ---------- the demo company ----------
const TERRITORIES: ReadonlyArray<{ id: string; label: string; unit: string }> =
  [
    { id: "t-ccn", label: "Cebu City North", unit: "u-north" },
    { id: "t-ccs", label: "Cebu City South", unit: "u-south" },
    { id: "t-mll", label: "Mandaue – Lapu-Lapu", unit: "u-north" },
    { id: "t-tmg", label: "Talisay – Minglanilla", unit: "u-south" },
  ];

type Agent = {
  id: string;
  name: string;
  territory: string;
  channel: string;
  position: string;
  /** Monthly target in pesos; null = not set yet (new hire). */
  target: number | null;
  perf: number;
  compliance: number;
  supervisor: string;
};

const RDS = "Route Distribution Salesman (RDS)";
const KAS = "Key Account Specialist (KAS)";
const PMOT = "PMOT Salesman";
const MS = "Merchandising Salesman";
const VAN = "Extruck Seller";

const AGENTS: Agent[] = [
  {
    id: "p01",
    name: "Ramon Dela Cruz",
    territory: "t-ccn",
    channel: "kas",
    position: KAS,
    target: 1_600_000,
    perf: 0.86,
    compliance: 0.9,
    supervisor: "s1",
  },
  {
    id: "p02",
    name: "Joy Villanueva",
    territory: "t-ccn",
    channel: "gt",
    position: RDS,
    target: 1_700_000,
    perf: 1.04,
    compliance: 0.94,
    supervisor: "s1",
  },
  {
    id: "p03",
    name: "Paolo Abella",
    territory: "t-ccn",
    channel: "pmot",
    position: PMOT,
    target: 1_050_000,
    perf: 0.83,
    compliance: 0.84,
    supervisor: "s1",
  },
  {
    id: "p04",
    name: "Liza Cabahug",
    territory: "t-ccs",
    channel: "mt",
    position: MS,
    target: 1_800_000,
    perf: 1.06,
    compliance: 0.96,
    supervisor: "s2",
  },
  {
    id: "p05",
    name: "Mark Ybañez",
    territory: "t-ccs",
    channel: "gt",
    position: RDS,
    target: 1_550_000,
    perf: 0.97,
    compliance: 0.88,
    supervisor: "s2",
  },
  {
    id: "p06",
    name: "Grace Tan",
    territory: "t-ccs",
    channel: "kas",
    position: KAS,
    target: 1_600_000,
    perf: 0.84,
    compliance: 0.86,
    supervisor: "s2",
  },
  {
    id: "p07",
    name: "Arnel Ouano",
    territory: "t-mll",
    channel: "mt",
    position: MS,
    target: 1_800_000,
    perf: 1.01,
    compliance: 0.92,
    supervisor: "s1",
  },
  {
    id: "p08",
    name: "Rhea Pepito",
    territory: "t-mll",
    channel: "gt",
    position: RDS,
    target: 1_500_000,
    perf: 0.95,
    compliance: 0.9,
    supervisor: "s1",
  },
  {
    id: "p09",
    name: "Dennis Sanchez",
    territory: "t-mll",
    channel: "pmot",
    position: PMOT,
    target: 1_050_000,
    perf: 0.86,
    compliance: 0.85,
    supervisor: "s1",
  },
  {
    id: "p10",
    name: "Carlo Alcoseba",
    territory: "t-tmg",
    channel: "gt",
    position: RDS,
    target: 1_450_000,
    perf: 0.78,
    compliance: 0.64,
    supervisor: "s2",
  },
  {
    id: "p11",
    name: "Marites Lim",
    territory: "t-tmg",
    channel: "pmot",
    position: PMOT,
    target: 1_000_000,
    perf: 0.8,
    compliance: 0.68,
    supervisor: "s2",
  },
  {
    id: "p12",
    name: "Rogelio Uy",
    territory: "t-mll",
    channel: "van",
    position: VAN,
    target: 750_000,
    perf: 0.84,
    compliance: 0.87,
    supervisor: "s1",
  },
  {
    id: "p13",
    name: "Nestor Cañete",
    territory: "t-tmg",
    channel: "van",
    position: VAN,
    target: 750_000,
    perf: 0.66,
    compliance: 0.8,
    supervisor: "s2",
  },
  {
    id: "p14",
    name: "Kevin Rama",
    territory: "t-tmg",
    channel: "gt",
    position: RDS,
    target: null,
    perf: 0.5,
    compliance: 0.82,
    supervisor: "s2",
  },
];
const SUPERVISORS = {
  s1: { profileId: "s1", name: "Edgar Rosales" },
  s2: { profileId: "s2", name: "Cristina Go" },
} as const;

const UNITS: UnitOption[] = [
  { id: "u-cebu", label: "Cebu sales region", depth: 0 },
  { id: "u-north", label: "North team (Edgar Rosales)", depth: 1 },
  { id: "u-south", label: "South team (Cristina Go)", depth: 1 },
  ...TERRITORIES.map((t) => ({ id: `u-${t.id}`, label: t.label, depth: 2 })),
];

function unitAgents(unitId: string | undefined) {
  if (!unitId || unitId === "u-cebu") return AGENTS;
  if (unitId === "u-north" || unitId === "u-south") {
    const territories = new Set(
      TERRITORIES.filter((t) => t.unit === unitId).map((t) => t.id),
    );
    return AGENTS.filter((a) => territories.has(a.territory));
  }
  return AGENTS.filter((a) => `u-${a.territory}` === unitId);
}

function unitLabel(unitId: string | undefined) {
  return UNITS.find((u) => u.id === unitId)?.label ?? "Cebu sales region";
}

const territoryLabel = (id: string) =>
  TERRITORIES.find((t) => t.id === id)?.label ?? id;

type Sku = {
  id: string;
  code: string;
  name: string;
  category: "Canned" | "Mixes" | "Frozen";
  pcsPerCase: number;
  casePrice: number;
  weight: number;
};

const SKU_SEED: Array<[string, Sku["category"], number, number]> = [
  ["Sunpride Premium Corned Beef 150g", "Canned", 48, 4_272],
  ["Sunpride Premium Corned Beef 260g", "Canned", 24, 3_456],
  ["Sunpride Corned Beef 380g", "Canned", 24, 4_680],
  ["Holiday Corned Beef 150g", "Canned", 48, 3_120],
  ["Holiday Luncheon Meat 340g", "Canned", 24, 3_672],
  ["Holiday Meat Loaf 150g", "Canned", 48, 1_824],
  ["Sunpride Beef Loaf 150g", "Canned", 48, 1_968],
  ["Shoppers Beef Loaf 150g", "Canned", 48, 1_536],
  ["Good Morning Luncheon Meat 165g", "Canned", 48, 3_264],
  ["Sunpride Pork & Beans 230g", "Canned", 48, 1_632],
  ["Sunpride Vienna Sausage 130g", "Canned", 48, 2_160],
  ["Holiday Chorizo Bilbao 150g", "Canned", 48, 3_744],
  ["Sunpride Liver Spread 85g", "Canned", 100, 2_350],
  ["Sunpride Chicken Spread 85g", "Canned", 100, 2_450],
  ["Kassel Corned Pork 150g", "Canned", 48, 2_064],
  ["Sunny Meat Loaf 100g", "Canned", 100, 2_100],
  ["Sunpride Sisig in Can 150g", "Canned", 48, 3_360],
  ["Sunpride Adobo Flakes 150g", "Canned", 48, 3_552],
  ["Holiday Spam-style Luncheon 340g", "Canned", 24, 4_104],
  ["Sunpride Corned Beef Sliced 1kg", "Canned", 12, 5_940],
  ["Shoppers Corned Beef 100g", "Canned", 100, 2_800],
  ["Sunpride Beef Caldereta 150g", "Canned", 48, 3_408],
  ["Sunpride Meat Balls 150g", "Canned", 48, 2_784],
  ["Good Morning Hash 150g", "Canned", 48, 2_256],
  ["Sunpride Tocino Mix 75g", "Mixes", 60, 1_380],
  ["Sunpride Longganisa Mix 75g", "Mixes", 60, 1_380],
  ["Sunpride Embutido Mix 90g", "Mixes", 60, 1_500],
  ["Sunpride Burger Mix 90g", "Mixes", 60, 1_440],
  ["Sunpride Lechon Paksiw Mix 50g", "Mixes", 100, 1_650],
  ["Sunpride Barbecue Marinade 120g", "Mixes", 48, 1_296],
  ["Sunpride Jumbo Hotdog 1kg", "Frozen", 10, 2_150],
  ["Sunpride Cheesy Hotdog 500g", "Frozen", 20, 2_380],
  ["Holiday Classic Hotdog 1kg", "Frozen", 10, 1_890],
  ["Sunpride Sweet Ham 1kg", "Frozen", 10, 3_250],
  ["Sunpride Bacon 500g", "Frozen", 20, 4_900],
  ["Sunpride Pork Tocino 450g", "Frozen", 20, 3_160],
  ["Sunpride Skinless Longganisa 500g", "Frozen", 20, 2_980],
  ["Meat Cuts Pork Belly 1kg", "Frozen", 10, 3_400],
  ["Sunpride Chicken Nuggets 400g", "Frozen", 20, 2_760],
  ["Sunpride Embutido 250g", "Frozen", 40, 3_600],
];

const SKUS: Sku[] = SKU_SEED.map(
  ([name, category, pcsPerCase, casePrice], i) => ({
    id: `sku${String(i + 1).padStart(2, "0")}`,
    code: `SP-${category.slice(0, 2).toUpperCase()}-${String(101 + i)}`,
    name,
    category,
    pcsPerCase,
    casePrice,
    weight: (i < 3 ? 3.2 : i < 10 ? 1.6 : 1) * (0.6 + noise(`w${i}`)),
  }),
);
const SKU_WEIGHT_TOTAL = SKUS.reduce((sum, sku) => sum + sku.weight, 0);

const STORE_PREFIX: Record<string, string[]> = {
  gt: [
    "Aling Nena",
    "Manang Lourdes",
    "Tindahan ni Bebe",
    "Junjun",
    "Nanay Ising",
    "Dodong",
    "Inday Merly",
    "Tatay Ben",
    "Ate Joy",
    "Lola Carmen",
  ],
  pmot: [
    "Carbon Market Stall",
    "Pasil Market Stall",
    "Taboan Stall",
    "Mandaue Public Market Stall",
    "Talisay Market Stall",
    "Tabunok Market Stall",
  ],
  mt: [
    "Gaisano Grand",
    "Metro Supermarket",
    "Prince Hypermart",
    "Savemore",
    "Puregold",
    "Island City Mall Grocery",
  ],
  kas: [
    "SM Hypermarket",
    "Robinsons Supermarket",
    "Landers",
    "S&R",
    "Rustan's Fresh",
    "Marketplace",
  ],
  van: [
    "Carinderia ni Linda",
    "Sari-sari Kanto",
    "Bakeshop Elena",
    "Eatery Bisdak",
    "Mini Mart Cora",
  ],
};
const BARANGAYS: Record<string, string[]> = {
  "t-ccn": ["Talamban", "Banilad", "Lahug", "Apas", "Kasambagan", "Guadalupe"],
  "t-ccs": [
    "Pardo",
    "Basak",
    "Labangon",
    "Mambaling",
    "Inayawan",
    "Punta Princesa",
  ],
  "t-mll": [
    "Paknaan",
    "Subangdaku",
    "Basak Mandaue",
    "Pusok",
    "Marigondon",
    "Gun-ob",
  ],
  "t-tmg": [
    "Tabunok",
    "Lawaan",
    "Bulacao",
    "Poblacion Minglanilla",
    "Tunghaan",
    "Linao",
  ],
};

type Store = {
  id: string;
  code: string;
  name: string;
  agent: Agent;
  status: StoreStatus;
  weight: number;
  creditLimit: number | null;
};

const STORES: Store[] = (() => {
  const perAgent: Record<string, number> = {
    kas: 12,
    mt: 16,
    gt: 32,
    pmot: 26,
    van: 20,
  };
  const out: Store[] = [];
  let n = 0;
  for (const agent of AGENTS) {
    const count = agent.id === "p14" ? 14 : perAgent[agent.channel]!;
    for (let i = 0; i < count && out.length < 312; i++) {
      n++;
      const prefixes = STORE_PREFIX[agent.channel]!;
      const places = BARANGAYS[agent.territory]!;
      const prefix = prefixes[i % prefixes.length]!;
      const place = places[(i + n) % places.length]!;
      const r = noise(`store${n}`);
      const status: StoreStatus =
        r < 0.7
          ? "active"
          : r < 0.82
            ? "dormant"
            : r < 0.86
              ? "new"
              : r < 0.92
                ? "lost"
                : "never";
      const big = agent.channel === "kas" || agent.channel === "mt";
      out.push({
        id: `st${String(n).padStart(3, "0")}`,
        code: `C-${String(10_000 + n * 7)}`,
        name:
          agent.channel === "gt" || agent.channel === "van"
            ? `${prefix} Store, ${place}`
            : `${prefix} ${place}`,
        agent,
        status:
          agent.compliance < 0.7 && r < 0.78 && r >= 0.62 ? "dormant" : status,
        weight: 0.4 + noise(`sw${n}`) * (big ? 2.4 : 1.2),
        creditLimit: big
          ? agent.channel === "kas"
            ? 900_000_00
            : 350_000_00
          : agent.channel === "gt"
            ? 40_000_00
            : null,
      });
    }
  }
  // Pad the universe to 312 with never-bought prospects.
  while (out.length < 312) {
    n++;
    const agent = AGENTS[n % AGENTS.length]!;
    out.push({
      id: `st${String(n).padStart(3, "0")}`,
      code: `C-${String(10_000 + n * 7)}`,
      name: `Prospect ${STORE_PREFIX.gt![n % 10]} Store, ${BARANGAYS[agent.territory]![n % 6]}`,
      agent,
      status: "never",
      weight: 0,
      creditLimit: null,
    });
  }
  return out;
})();

// ---------- the sales fact ----------
const isSunday = (date: string) =>
  new Date(`${date}T00:00:00Z`).getUTCDay() === 0;

function sellingDaysInMonth(month: string) {
  const first = `${month}-01`;
  let count = 0;
  for (let d = first; d.slice(0, 7) === month; d = addDays(d, 1))
    if (!isSunday(d)) count++;
  return count;
}

function sellingDays(from: string, to: string) {
  let count = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isSunday(d)) count++;
  return count;
}

type Clock = { today: string; now: number };

/** Share of a day's selling done by `now` on the current day. */
function dayShare(date: string, clock: Clock) {
  if (date > clock.today) return 0;
  if (date < clock.today) return 1;
  const hour = (clock.now - at(date, 0)) / 3_600_000;
  return Math.max(0, Math.min(1, (hour - 8) / 9));
}

/** One agent's net sales (centavos) on one date. */
function agentDaySales(agent: Agent, date: string, clock: Clock) {
  if (isSunday(date)) return 0;
  const monthTarget = agent.target ?? 600_000;
  const daily = (monthTarget * 100) / 26;
  const yearFactor = date < "2026-01-01" ? 0.88 : 1;
  const raw =
    daily *
    agent.perf *
    yearFactor *
    (0.78 + noise(`${agent.id}${date}`) * 0.44);
  return Math.round(raw * dayShare(date, clock));
}

function agentTarget(agent: Agent, from: string, to: string) {
  if (agent.target === null) return null;
  let total = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isSunday(d)) continue;
    total += (agent.target * 100) / sellingDaysInMonth(d.slice(0, 7));
  }
  return Math.round(total);
}

function sumSales(agents: Agent[], from: string, to: string, clock: Clock) {
  let total = 0;
  for (const agent of agents)
    for (let d = from; d <= to; d = addDays(d, 1))
      total += agentDaySales(agent, d, clock);
  return total;
}

function sumTarget(agents: Agent[], from: string, to: string) {
  if (from === to && isSunday(from)) return null;
  let total = 0;
  let any = false;
  for (const agent of agents) {
    const target = agentTarget(agent, from, to);
    if (target !== null) {
      total += target;
      any = true;
    }
  }
  return any ? total : null;
}

/** Status against the pro-rated target (ANALYTICS_V2 §0 status rule). */
function statusFor(
  value: number | null,
  proratedTarget: number | null,
): KpiStatus {
  if (value === null || proratedTarget === null || proratedTarget <= 0)
    return "unknown";
  const pct = (value / proratedTarget) * 100;
  return pct < 90 ? "behind" : pct < 100 ? "watch" : "ok";
}

function deltaPct(value: number | null, prior: number | null) {
  if (value === null || prior === null || prior === 0) return null;
  return round1(((value - prior) / prior) * 100);
}

function kpi(
  key: string,
  label: string,
  unit: KpiUnit,
  value: number | null,
  options: {
    target?: number | null;
    prior?: number | null;
    status?: KpiStatus;
    definition: string;
  },
): Kpi {
  const target = options.target ?? null;
  const prior = options.prior ?? null;
  return {
    key,
    label,
    value,
    unit,
    target,
    prior,
    deltaPct: deltaPct(value, prior),
    status:
      value === null ? "unknown" : (options.status ?? statusFor(value, target)),
    definition: options.definition,
  };
}

const SALES_DEF =
  "Net value of order lines on orders not in draft, rejected or voided, dated by the Manila order date; van sales count on sale.";

// ---------- header ----------
function clockFor(query: Query, now: number): Clock {
  const realToday = manilaToday(now);
  return { today: realToday, now };
}

function rangeFor(query: Query, clock: Clock) {
  if (isIsoDate(query.date)) return { from: query.date, to: query.date };
  if (isIsoDate(query.from) && isIsoDate(query.to) && query.from <= query.to)
    return { from: query.from, to: query.to };
  return presetRange("mtd", clock.today);
}

function compareFor(from: string, to: string, mode: string | undefined) {
  if (mode === "ly")
    return {
      from: `${Number(from.slice(0, 4)) - 1}${from.slice(4)}`,
      to: `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`,
    };
  const days = daysBetween(from, to);
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

function header(
  query: Query,
  clock: Clock,
  range = rangeFor(query, clock),
): ResponseHeader {
  const { from, to } = range;
  const days = daysBetween(from, to);
  const elapsed =
    clock.today < from
      ? 0
      : clock.today >= to
        ? days
        : daysBetween(from, clock.today);
  const month = to.slice(0, 7);
  const monthEnd = addDays(`${month}-01`, 40).slice(0, 7) + "-01";
  const remaining =
    clock.today.slice(0, 7) === month
      ? sellingDays(addDays(clock.today, 1), addDays(monthEnd, -1))
      : 0;
  return {
    period: {
      from,
      to,
      days,
      elapsedDays: elapsed,
      remainingSellingDays: remaining,
    },
    compare: compareFor(from, to, query.compare),
    scope: { unitId: query.unitId ?? "u-cebu", label: unitLabel(query.unitId) },
    freshness: {
      asOf: clock.now,
      devicesBehind: 3,
      oldestDeviceSyncAt: clock.now - 55 * 60_000,
    },
    demo: true,
  };
}

function scopedAgents(query: Query) {
  const agents = unitAgents(query.unitId);
  return query.channel
    ? agents.filter((a) => a.channel === query.channel)
    : agents;
}

const DROP: Record<string, number> = {
  kas: 42_000_00,
  mt: 18_500_00,
  gt: 3_800_00,
  pmot: 1_950_00,
  van: 2_600_00,
};

function ordersFor(agents: Agent[], sales: number) {
  if (!agents.length || sales <= 0) return 0;
  const drop = agents.reduce((s, a) => s + DROP[a.channel]!, 0) / agents.length;
  return Math.max(1, Math.round(sales / drop));
}

function activeStores(agents: Agent[]) {
  const ids = new Set(agents.map((a) => a.id));
  return STORES.filter(
    (s) => ids.has(s.agent.id) && (s.status === "active" || s.status === "new"),
  );
}

/** Per-person sums, so a partition by channel, territory or agent adds up to the total. */
function ordersOf(
  agents: Agent[],
  from: string,
  to: string,
  factor: number,
  clock: Clock,
) {
  return agents.reduce((n, a) => {
    const value = Math.round(sumSales([a], from, to, clock) * factor);
    return (
      n + (value > 0 ? Math.max(1, Math.round(value / DROP[a.channel]!)) : 0)
    );
  }, 0);
}
function uboOf(agents: Agent[], days: number, factor: number) {
  return agents.reduce(
    (n, a) => n + Math.round(uboFor([a], days) * Math.min(1, factor * 3)),
    0,
  );
}
function uboFor(agents: Agent[], days: number) {
  const active = activeStores(agents).length;
  return Math.round(active * Math.min(1, 0.35 + days / 14));
}

// ---------- /today ----------
function today(query: Query, clock: Clock): TodayResponse {
  const date = isIsoDate(query.date) ? query.date : clock.today;
  const head = header({ ...query, date }, clock, { from: date, to: date });
  const agents = scopedAgents(query);
  const month = date.slice(0, 7);
  const monthStart = `${month}-01`;
  const monthEnd = addDays(addDays(monthStart, 40).slice(0, 7) + "-01", -1);
  const salesToday = sumSales(agents, date, date, clock);
  const dayTarget = sumTarget(agents, date, date);
  const yesterday = addDays(date, isSunday(addDays(date, -1)) ? -2 : -1);
  const mtd = sumSales(agents, monthStart, date, clock);
  const mtdTarget = sumTarget(agents, monthStart, date);
  const monthTarget = sumTarget(agents, monthStart, monthEnd);
  const priorMonthStart = `${addDays(monthStart, -1).slice(0, 7)}-01`;
  const priorMtd = sumSales(
    agents,
    priorMonthStart,
    addDays(priorMonthStart, daysBetween(monthStart, date) - 1),
    clock,
  );
  const remaining =
    head.period.remainingSellingDays + (dayShare(date, clock) < 1 ? 1 : 0);
  const balance = monthTarget === null ? null : Math.max(0, monthTarget - mtd);
  const perDay =
    balance === null || remaining <= 0 ? null : Math.round(balance / remaining);

  const people = agents.map((agent) => {
    const planned = isSunday(date) ? 0 : plannedPerDay(agent);
    const share = dayShare(date, clock);
    const visited = Math.round(planned * agent.compliance * share);
    const r = noise(`fs${agent.id}${date}`);
    const status =
      agent.id === "p11"
        ? "not_started"
        : agent.id === "p14"
          ? "no_plan"
          : agent.id === "p03"
            ? "idle"
            : share >= 1
              ? "done"
              : r < 0.55
                ? "in_call"
                : r < 0.8
                  ? "done"
                  : "in_call";
    return {
      profileId: agent.id,
      name: agent.name,
      territory: territoryLabel(agent.territory),
      status: status as TodayResponse["field"]["people"][number]["status"],
      lastSeenAt:
        status === "not_started" || status === "no_plan"
          ? status === "no_plan"
            ? clock.now - 5 * 3_600_000
            : null
          : clock.now -
            Math.round(r * 40 + (status === "idle" ? 74 : 2)) * 60_000,
      planned: status === "no_plan" ? 0 : planned,
      visited: status === "not_started" || status === "no_plan" ? 0 : visited,
      productive:
        status === "not_started" || status === "no_plan"
          ? 0
          : Math.round(visited * 0.72),
      sales: status === "not_started" ? 0 : agentDaySales(agent, date, clock),
    };
  });
  const counts = { noPlan: 0, notStarted: 0, inCall: 0, done: 0, idle: 0 };
  for (const p of people) {
    if (p.status === "no_plan") counts.noPlan++;
    else if (p.status === "not_started") counts.notStarted++;
    else if (p.status === "in_call") counts.inCall++;
    else if (p.status === "done") counts.done++;
    else counts.idle++;
  }
  const planned = people.reduce((s, p) => s + p.planned, 0);
  const visited = people.reduce((s, p) => s + p.visited, 0);
  const productive = people.reduce((s, p) => s + p.productive, 0);
  const vans = vanRows(date, clock, query);
  const collections = Math.round(salesToday * 0.41);
  const exceptions = allExceptions(clock, date)
    .filter(
      (item) =>
        !query.unitId ||
        agents.some(
          (a) =>
            item.owner?.profileId === a.supervisor || item.subject.id === a.id,
        ),
    )
    .sort(bySeverity)
    .slice(0, 5);

  const byChannel = CHANNELS.filter(
    (c) => !query.channel || c.key === query.channel,
  )
    .map((channel) => {
      const members = agents.filter((a) => a.channel === channel.key);
      const sales = sumSales(members, monthStart, date, clock);
      const target = sumTarget(members, monthStart, date);
      return {
        channel: channel.key,
        label: channel.label,
        sales,
        target,
        attainmentPct: target ? pctOf(sales, target) : null,
        status: statusFor(sales, target),
      };
    })
    .filter((row) => row.sales > 0 || row.target !== null);

  const trend: TodayResponse["trend"] = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(date, -i);
    trend.push({
      date: d,
      sales: sumSales(agents, d, d, clock),
      target: sumTarget(agents, d, d),
    });
  }

  return {
    ...head,
    kpis: [
      kpi("salesToday", "Sales today", "php", salesToday, {
        target: dayTarget,
        status: statusFor(
          salesToday,
          dayTarget === null
            ? null
            : Math.round(dayTarget * dayShare(date, clock)),
        ),
        prior: Math.round(
          sumSales(agents, yesterday, yesterday, clock) * dayShare(date, clock),
        ),
        definition: `${SALES_DEF} Compared with the previous selling day up to the same hour. Target is the day's share of the monthly target; the status compares with the share due by this hour.`,
      }),
      kpi("mtdSales", "Month to date", "php", mtd, {
        target: mtdTarget,
        prior: priorMtd,
        definition: `${SALES_DEF} Compared with the same days of last month.`,
      }),
      kpi("balanceToSell", "Balance to sell", "php", balance, {
        target: monthTarget,
        status: statusFor(mtd, mtdTarget),
        definition:
          "Monthly target minus month-to-date sales. Zero once the month's target is reached.",
      }),
      kpi("perDayNeeded", "Needed per selling day", "php", perDay, {
        prior:
          monthTarget === null
            ? null
            : Math.round(monthTarget / sellingDaysInMonth(month)),
        status: perDay === null ? "unknown" : statusFor(mtd, mtdTarget),
        definition:
          "Balance to sell divided by the selling days left this month (Sundays excluded). Prior is the even daily pace.",
      }),
      kpi(
        "coverage",
        "Stops covered",
        "pct",
        pctOf(visited, Math.round(planned * dayShare(date, clock))),
        {
          target: 90,
          prior: 86.4,
          definition:
            "Planned MCP stops visited so far today out of the stops planned up to this hour.",
        },
      ),
      kpi(
        "productiveCalls",
        "Productive calls",
        "pct",
        pctOf(productive, visited),
        {
          target: 85,
          prior: 71.8,
          status: statusFor(pctOf(productive, visited), 85),
          definition:
            "Visits that met the call objective for the channel (an order, a collection or the required activity) out of all visits today.",
        },
      ),
      kpi("collectionsToday", "Collections today", "php", collections, {
        prior: Math.round(sumSales(agents, yesterday, yesterday, clock) * 0.44),
        status: "unknown",
        definition:
          "Cash and cheques recorded as collected today, by the Manila collection date. No collection target is set yet.",
      }),
      kpi(
        "vansOut",
        "Vans out",
        "count",
        vans.filter((v) => v.status === "on_route" || v.status === "loading")
          .length,
        {
          prior: 2,
          status: vans.some((v) => v.status === "unclosed") ? "behind" : "ok",
          definition:
            "Van trips loaded or on route right now. A trip still open from an earlier day counts as not closed.",
        },
      ),
    ],
    byChannel,
    field: { counts, people },
    vans: vans.map((v) => ({
      tripId: v.tripId,
      truck: v.truck,
      seller: v.seller,
      status: v.status,
      salesCentavos: v.salesCentavos,
      cashExpected: v.cashExpected,
      cashRemitted: v.cashRemitted,
      variance: v.variance,
    })),
    exceptions,
    trend,
  };
}

function plannedPerDay(agent: Agent) {
  return { kas: 6, mt: 10, gt: 28, pmot: 30, van: 24 }[agent.channel] ?? 20;
}

// ---------- /sales ----------
const NEXT_LEVEL: Partial<Record<SalesGroupBy, SalesGroupBy>> = {
  channel: "territory",
  territory: "agent",
  agent: "store",
  category: "sku",
  sku: "store",
};

function parseParent(parent: string | undefined) {
  if (!parent) return null;
  const index = parent.indexOf(":");
  if (index < 1) return null;
  return {
    groupBy: parent.slice(0, index) as SalesGroupBy,
    key: parent.slice(index + 1),
  };
}

function filtered(query: Query) {
  let agents = scopedAgents(query);
  let skus = SKUS;
  let stores: Store[] | null = null;
  const parent = parseParent(query.parent);
  if (parent?.groupBy === "channel")
    agents = agents.filter((a) => a.channel === parent.key);
  if (parent?.groupBy === "territory")
    agents = agents.filter((a) => a.territory === parent.key);
  if (parent?.groupBy === "agent")
    agents = agents.filter((a) => a.id === parent.key);
  if (parent?.groupBy === "category")
    skus = skus.filter((s) => s.category === parent.key);
  if (parent?.groupBy === "sku") skus = skus.filter((s) => s.id === parent.key);
  if (parent?.groupBy === "store") {
    stores = STORES.filter((s) => s.id === parent.key);
    agents = agents.filter((a) => stores!.some((s) => s.agent.id === a.id));
  }
  const skuShare =
    skus.reduce((s, sku) => s + sku.weight, 0) / SKU_WEIGHT_TOTAL;
  return { agents, skus, skuShare, stores };
}

function storeShare(store: Store) {
  const peers = activeStores([store.agent]);
  if (!peers.some((p) => p.id === store.id)) return 0;
  return store.weight / peers.reduce((s, p) => s + p.weight, 0);
}

function sales(query: Query, clock: Clock): SalesResponse {
  const head = header(query, clock);
  const { from, to } = head.period;
  const cmp = head.compare;
  const groupBy = (
    ["channel", "territory", "agent", "category", "sku", "store"].includes(
      query.groupBy ?? "",
    )
      ? query.groupBy
      : "territory"
  ) as SalesGroupBy;
  const scope = filtered(query);
  const share = scope.skuShare;
  const storeFilter = scope.stores;
  const scaleFor = (agentSet: Agent[], fromD: string, toD: string) => {
    if (!storeFilter)
      return Math.round(sumSales(agentSet, fromD, toD, clock) * share);
    return Math.round(
      storeFilter.reduce(
        (s, st) => s + sumSales([st.agent], fromD, toD, clock) * storeShare(st),
        0,
      ) * share,
    );
  };
  const total = scaleFor(scope.agents, from, to);
  const prior = scaleFor(scope.agents, cmp.from, cmp.to);
  const targetFull =
    storeFilter || share < 0.999 ? null : sumTarget(scope.agents, from, to);
  const elapsedTo = clock.today < to ? clock.today : to;
  const targetToDate =
    storeFilter || share < 0.999 || clock.today < from
      ? null
      : sumTarget(scope.agents, from, elapsedTo);
  const monthEnd = addDays(
    addDays(`${to.slice(0, 7)}-01`, 40).slice(0, 7) + "-01",
    -1,
  );
  const monthTarget =
    targetFull === null
      ? null
      : sumTarget(scope.agents, `${to.slice(0, 7)}-01`, monthEnd);
  const mtdSales = scaleFor(scope.agents, `${to.slice(0, 7)}-01`, to);
  const balance =
    monthTarget === null ? null : Math.max(0, monthTarget - mtdSales);
  const remaining =
    head.period.remainingSellingDays +
    (dayShare(clock.today, clock) < 1 &&
    clock.today <= to &&
    clock.today >= from
      ? 1
      : 0);
  const orders = storeFilter
    ? ordersFor(scope.agents, total)
    : ordersOf(scope.agents, from, to, share, clock);
  const priorOrders = storeFilter
    ? ordersFor(scope.agents, prior)
    : ordersOf(scope.agents, cmp.from, cmp.to, share, clock);
  const ubo = storeFilter
    ? total > 0
      ? 1
      : 0
    : uboOf(scope.agents, head.period.days, share);
  const priorUbo = Math.round(ubo * 0.96);

  const rowsFor = (): SalesRow[] => {
    const next = NEXT_LEVEL[groupBy] ?? null;
    const build = (
      key: string,
      label: string,
      agentSet: Agent[],
      skuFactor: number,
      target: number | null,
      storeSet?: Store[],
    ): SalesRow => {
      const calc = (f: string, t: string) =>
        storeSet
          ? Math.round(
              storeSet.reduce(
                (s, st) =>
                  s + sumSales([st.agent], f, t, clock) * storeShare(st),
                0,
              ) * skuFactor,
            )
          : Math.round(sumSales(agentSet, f, t, clock) * skuFactor);
      const value = calc(from, to);
      const priorValue = calc(cmp.from, cmp.to);
      const ord = storeSet
        ? value > 0
          ? Math.max(1, Math.round(value / DROP[storeSet[0]!.agent.channel]!))
          : 0
        : ordersOf(agentSet, from, to, skuFactor, clock);
      const targetToDateRow =
        target === null || clock.today < from
          ? null
          : Math.round(
              (target * sellingDays(from, elapsedTo)) /
                Math.max(1, sellingDays(from, to)),
            );
      return {
        key,
        label,
        sales: value,
        target,
        attainmentPct: targetToDateRow ? pctOf(value, targetToDateRow) : null,
        prior: priorValue,
        deltaPct: deltaPct(value, priorValue),
        orders: ord,
        dropSize: ord ? Math.round(value / ord) : null,
        ubo: storeSet
          ? value > 0
            ? storeSet.length
            : 0
          : uboOf(agentSet, head.period.days, skuFactor),
        status: statusFor(value, targetToDateRow),
        drill: next ? { groupBy: next, parent: `${groupBy}:${key}` } : null,
      };
    };
    const withTarget = share >= 0.999 && !storeFilter;
    switch (groupBy) {
      case "channel":
        return CHANNELS.map((c) => {
          const members = scope.agents.filter((a) => a.channel === c.key);
          return members.length
            ? build(
                c.key,
                c.label,
                members,
                share,
                withTarget ? sumTarget(members, from, to) : null,
              )
            : null;
        }).filter((r): r is SalesRow => r !== null);
      case "territory":
        return TERRITORIES.map((t) => {
          const members = scope.agents.filter((a) => a.territory === t.id);
          return members.length
            ? build(
                t.id,
                t.label,
                members,
                share,
                withTarget ? sumTarget(members, from, to) : null,
              )
            : null;
        }).filter((r): r is SalesRow => r !== null);
      case "agent":
        return scope.agents.map((a) =>
          build(
            a.id,
            a.name,
            [a],
            share,
            withTarget ? agentTarget(a, from, to) : null,
          ),
        );
      case "category":
        return (["Canned", "Mixes", "Frozen"] as const)
          .map((category) => {
            const set = scope.skus.filter((s) => s.category === category);
            if (!set.length) return null;
            return build(
              category,
              category,
              scope.agents,
              set.reduce((s, k) => s + k.weight, 0) / SKU_WEIGHT_TOTAL,
              null,
              storeFilter ?? undefined,
            );
          })
          .filter((r): r is SalesRow => r !== null);
      case "sku":
        return scope.skus.map((sku) =>
          build(
            sku.id,
            sku.name,
            scope.agents,
            sku.weight / SKU_WEIGHT_TOTAL,
            null,
            storeFilter ?? undefined,
          ),
        );
      case "store": {
        const stores = storeFilter ?? activeStores(scope.agents);
        return stores.map((st) =>
          build(st.id, st.name, [st.agent], share, null, [st]),
        );
      }
    }
  };
  const rows = rowsFor().sort((a, b) => b.sales - a.sales);

  const trend: SalesResponse["trend"] = [];
  let cumSales = 0;
  let cumTarget: number | null = targetFull === null ? null : 0;
  let cumPrior = 0;
  const days = daysBetween(from, to);
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    const pd = addDays(cmp.from, i);
    const s = d > clock.today ? 0 : scaleFor(scope.agents, d, d);
    cumSales += s;
    if (cumTarget !== null) cumTarget += sumTarget(scope.agents, d, d) ?? 0;
    cumPrior += pd <= cmp.to ? scaleFor(scope.agents, pd, pd) : 0;
    trend.push({
      date: d,
      sales: s,
      cumSales: d > clock.today ? cumSales : cumSales,
      cumTarget,
      cumPrior,
    });
  }

  return {
    ...head,
    kpis: [
      kpi("sales", "Sales", "php", total, {
        target: targetToDate,
        prior,
        definition: SALES_DEF,
      }),
      kpi("target", "Target for the period", "php", targetFull, {
        status:
          targetFull === null ? "unknown" : statusFor(total, targetToDate),
        definition:
          "Sum of the monthly sales targets, pro-rated by selling days (Sundays excluded) over the period.",
      }),
      kpi(
        "attainment",
        "Attainment to date",
        "pct",
        targetToDate ? pctOf(total, targetToDate) : null,
        {
          target: 100,
          prior: null,
          status: statusFor(total, targetToDate),
          definition:
            "Sales divided by the target pro-rated to today. Behind under 90%, watch from 90% to 99%, on target from 100%.",
        },
      ),
      kpi("balanceToSell", "Balance to sell this month", "php", balance, {
        target: monthTarget,
        status: statusFor(mtdSales, targetToDate),
        definition: "Monthly target minus month-to-date sales.",
      }),
      kpi(
        "perDayNeeded",
        "Needed per selling day",
        "php",
        balance === null || remaining <= 0
          ? null
          : Math.round(balance / remaining),
        {
          status:
            balance === null ? "unknown" : statusFor(mtdSales, targetToDate),
          definition:
            "Balance to sell divided by the selling days left this month.",
        },
      ),
      kpi("orders", "Orders", "count", orders, {
        prior: priorOrders,
        status: "ok",
        definition:
          "Orders that count as sales (not draft, rejected or voided) in the period.",
      }),
      kpi(
        "dropSize",
        "Average drop size",
        "php",
        orders ? Math.round(total / orders) : null,
        {
          prior: priorOrders ? Math.round(prior / priorOrders) : null,
          status: "ok",
          definition:
            "Sales divided by orders: the average value of one order.",
        },
      ),
      kpi(
        "linesPerOrder",
        "Lines per order",
        "count",
        orders ? round1(6.1 + noise(`lpo${query.parent ?? ""}`) * 1.4) : null,
        {
          prior: 6.4,
          status: "ok",
          definition: "Average number of different products on one order.",
        },
      ),
      kpi("ubo", "Buying stores (UBO)", "count", ubo, {
        prior: priorUbo,
        status: "ok",
        definition:
          "Unique stores with at least one order that counts as sales in the period.",
      }),
    ],
    stages: {
      booked: total,
      approved: Math.round(total * 0.932),
      posted: Math.round(total * 0.814),
    },
    trend,
    rows,
  };
}

// ---------- /coverage ----------
function coverage(query: Query, clock: Clock): CoverageResponse {
  const head = header(query, clock);
  const { from, to } = head.period;
  const until = clock.today < to ? clock.today : to;
  const daysWorked = clock.today < from ? 0 : sellingDays(from, until);
  const agents = scopedAgents(query);
  const weeks: CoverageResponse["weeks"] = [];
  const lastMonday = addDays(
    until,
    -((new Date(`${until}T00:00:00Z`).getUTCDay() + 6) % 7),
  );
  for (let i = 4; i >= 0; i--)
    weeks.push({ weekStart: addDays(lastMonday, -7 * i) });

  const agentRow = (a: Agent): CoverageResponse["rows"][number] => {
    const planned = plannedPerDay(a) * daysWorked;
    const visited = Math.round(planned * a.compliance);
    const productive = Math.round(visited * (0.62 + noise(`pr${a.id}`) * 0.2));
    const first = at(
      until,
      8,
      5 + Math.round(noise(`f${a.id}`) * 50) + (a.compliance < 0.7 ? 55 : 0),
    );
    const time = Math.round(
      330 + a.compliance * 90 - (a.compliance < 0.7 ? 80 : 0),
    );
    return {
      key: a.id,
      label: a.name,
      planned,
      visited,
      compliancePct: pctOf(visited, planned),
      missed: planned - visited,
      offPlan: Math.round(visited * 0.04 * noise(`op${a.id}`)),
      productive,
      strikeRatePct: pctOf(productive, visited),
      linesPerCall: round1(4.2 + noise(`lpc${a.id}`) * 2.6),
      firstCallAt: daysWorked ? first : null,
      lastCallAt: daysWorked ? first + time * 60_000 : null,
      timeInMarketMin: daysWorked ? time : null,
      workWith: {
        done:
          a.compliance < 0.7
            ? 1
            : Math.min(4, Math.round(noise(`ww${a.id}`) * 4) + 1),
        required: 4,
      },
      weekly: weeks.map((w, i) =>
        a.id === "p14" && i < 3
          ? null
          : round1(
              a.compliance * 100 +
                (noise(`wk${a.id}${w.weekStart}`) - 0.5) * 12,
            ),
      ),
      status: statusFor(pctOf(visited, planned), 90),
    };
  };
  let rows = agents.map(agentRow);
  if (query.groupBy === "territory") {
    rows = TERRITORIES.flatMap((t) => {
      const members = rows.filter(
        (r) => agents.find((a) => a.id === r.key)?.territory === t.id,
      );
      if (!members.length) return [];
      const sum = (pick: (r: (typeof rows)[number]) => number) =>
        members.reduce((s, r) => s + pick(r), 0);
      const planned = sum((r) => r.planned);
      const visited = sum((r) => r.visited);
      const productive = sum((r) => r.productive);
      return [
        {
          key: t.id,
          label: t.label,
          planned,
          visited,
          compliancePct: pctOf(visited, planned),
          missed: planned - visited,
          offPlan: sum((r) => r.offPlan),
          productive,
          strikeRatePct: pctOf(productive, visited),
          linesPerCall: round1(
            sum((r) => r.linesPerCall ?? 0) / members.length,
          ),
          firstCallAt: Math.min(
            ...members.map((r) => r.firstCallAt ?? Infinity),
          ),
          lastCallAt: Math.max(...members.map((r) => r.lastCallAt ?? 0)),
          timeInMarketMin: Math.round(
            sum((r) => r.timeInMarketMin ?? 0) / members.length,
          ),
          workWith: {
            done: sum((r) => r.workWith.done),
            required: sum((r) => r.workWith.required ?? 0),
          },
          weekly: weeks.map((_, i) => {
            const values = members
              .map((r) => r.weekly[i])
              .filter((v): v is number => v !== null && v !== undefined);
            return values.length
              ? round1(values.reduce((s, v) => s + v, 0) / values.length)
              : null;
          }),
          status: statusFor(pctOf(visited, planned), 90),
        },
      ];
    });
  }
  rows.sort((a, b) => (a.compliancePct ?? 0) - (b.compliancePct ?? 0));
  const planned = rows.reduce((s, r) => s + r.planned, 0);
  const visited = rows.reduce((s, r) => s + r.visited, 0);
  const productive = rows.reduce((s, r) => s + r.productive, 0);
  const wwDone = rows.reduce((s, r) => s + r.workWith.done, 0);
  const wwRequired = rows.reduce((s, r) => s + (r.workWith.required ?? 0), 0);
  return {
    ...head,
    kpis: [
      kpi("compliance", "MCP compliance", "pct", pctOf(visited, planned), {
        target: 90,
        prior: 83.9,
        definition:
          "Planned MCP stops visited out of planned stops in the period.",
      }),
      kpi("missedStops", "Missed stops", "count", planned - visited, {
        prior: Math.round((planned - visited) * 1.12),
        status: planned - visited > planned * 0.1 ? "behind" : "ok",
        definition: "Planned stops with no check-in on their planned day.",
      }),
      kpi(
        "offPlanVisits",
        "Off-plan visits",
        "count",
        rows.reduce((s, r) => s + r.offPlan, 0),
        {
          prior: 41,
          status: "ok",
          definition: "Check-ins at stores that were not on the day's MCP.",
        },
      ),
      kpi("strikeRate", "Strike rate", "pct", pctOf(productive, visited), {
        target: 85,
        prior: 70.2,
        definition:
          "Productive visits out of all visits: the visit met its call objective.",
      }),
      kpi(
        "linesPerCall",
        "Lines per call",
        "count",
        round1(
          rows.reduce((s, r) => s + (r.linesPerCall ?? 0), 0) /
            Math.max(1, rows.length),
        ),
        {
          prior: 5.1,
          status: "ok",
          definition:
            "Average number of different products ordered on a productive call.",
        },
      ),
      kpi(
        "timeInMarket",
        "Time in market",
        "minutes",
        Math.round(
          rows.reduce((s, r) => s + (r.timeInMarketMin ?? 0), 0) /
            Math.max(1, rows.length),
        ),
        {
          target: 420,
          prior: 401,
          definition:
            "Average minutes from first check-in to last check-out per selling day.",
        },
      ),
      kpi("workWithDone", "Work-With sessions", "count", wwDone, {
        target: wwRequired,
        prior: null,
        definition:
          "Supervisor Work-With sessions done against the monthly minimum for each person.",
      }),
    ],
    weeks,
    rows,
  };
}

// ---------- /agent-day ----------
function agentDay(query: Query, clock: Clock): AgentDayResponse {
  const agent = AGENTS.find((a) => a.id === query.profileId) ?? AGENTS[1]!;
  const date = isIsoDate(query.date) ? query.date : clock.today;
  const head = header({ ...query, date }, clock, { from: date, to: date });
  const stores = STORES.filter((s) => s.agent.id === agent.id);
  const share = dayShare(date, clock);
  const planned = plannedPerDay(agent);
  const visits = Math.round(
    Math.min(planned, stores.length) * agent.compliance * share,
  );
  const timeline: AgentDayResponse["timeline"] = [];
  const trail: AgentDayResponse["trail"] = [];
  let t = at(date, 8, agent.compliance < 0.7 ? 58 : 6);
  let lat = 10.33 - noise(`lat${agent.id}`) * 0.08;
  let lng = 123.9 - noise(`lng${agent.id}`) * 0.06;
  const daySales = agentDaySales(agent, date, clock);
  let soldSoFar = 0;
  let productive = 0;
  for (let i = 0; i < visits && t < clock.now; i++) {
    const store = stores[i % stores.length]!;
    const onPlan = noise(`onp${agent.id}${i}`) > 0.06;
    trail.push({ at: t, lat, lng });
    timeline.push({
      at: t,
      kind: "check_in",
      storeId: store.id,
      storeLabel: store.name,
      detail: onPlan ? "Planned stop" : "Not on today's plan",
      amountCentavos: null,
      onPlan,
    });
    const r = noise(`v${agent.id}${date}${i}`);
    if (r < 0.72) {
      productive++;
      const amount =
        i === visits - 1
          ? Math.max(0, daySales - soldSoFar)
          : Math.round(
              (daySales / Math.max(1, visits * 0.72)) * (0.6 + r * 0.8),
            );
      soldSoFar += amount;
      timeline.push({
        at: t + 9 * 60_000,
        kind: "order",
        storeId: store.id,
        storeLabel: store.name,
        detail: `${4 + Math.round(r * 5)} lines`,
        amountCentavos: amount,
        onPlan,
      });
    } else if (r < 0.8) {
      timeline.push({
        at: t + 8 * 60_000,
        kind: "collection",
        storeId: store.id,
        storeLabel: store.name,
        detail: "Cash collected against invoice",
        amountCentavos: Math.round(4_500_00 + r * 10_000_00),
        onPlan,
      });
    } else {
      timeline.push({
        at: t + 7 * 60_000,
        kind: "activity",
        storeId: store.id,
        storeLabel: store.name,
        detail: "Shelf check: corned beef facings restored",
        amountCentavos: null,
        onPlan,
      });
    }
    const dwell = Math.round(12 + r * 14);
    timeline.push({
      at: t + dwell * 60_000,
      kind: "check_out",
      storeId: store.id,
      storeLabel: store.name,
      detail: `${dwell} min in store`,
      amountCentavos: null,
      onPlan,
    });
    t += (dwell + 6 + Math.round(noise(`tr${i}`) * 10)) * 60_000;
    lat += (noise(`dl${agent.id}${i}`) - 0.45) * 0.006;
    lng += (noise(`dg${agent.id}${i}`) - 0.45) * 0.006;
    if (i === Math.floor(visits / 2)) {
      timeline.push({
        at: t,
        kind: "gap",
        storeId: null,
        storeLabel: null,
        detail:
          agent.compliance < 0.7
            ? "No activity for 1 h 35 min"
            : "Lunch break, 48 min",
        amountCentavos: null,
        onPlan: null,
      });
      t += (agent.compliance < 0.7 ? 95 : 48) * 60_000;
    }
  }
  const visited = timeline.filter((e) => e.kind === "check_in").length;
  const sold = timeline
    .filter((e) => e.kind === "order")
    .reduce((s, e) => s + (e.amountCentavos ?? 0), 0);
  return {
    ...head,
    person: {
      profileId: agent.id,
      name: agent.name,
      territory: territoryLabel(agent.territory),
      position: agent.position,
    },
    summary: {
      planned: isSunday(date) ? 0 : planned,
      visited,
      productive,
      sales: sold,
      firstCallAt: timeline[0]?.at ?? null,
      lastCallAt: timeline.length ? timeline[timeline.length - 1]!.at : null,
      distanceKm: visited ? round1(visited * 0.62) : null,
    },
    timeline,
    trail,
  };
}

// ---------- /stores ----------
function storeRows(
  query: Query,
  clock: Clock,
  head: ResponseHeader,
): StoreRow[] {
  const agents = new Set(scopedAgents(query).map((a) => a.id));
  const { from, to } = head.period;
  return STORES.filter((s) => agents.has(s.agent.id)).map((s): StoreRow => {
    const share = storeShare(s);
    const period = Math.round(sumSales([s.agent], from, to, clock) * share);
    const prior = Math.round(
      sumSales([s.agent], head.compare.from, head.compare.to, clock) * share,
    );
    const daysSince =
      s.status === "active"
        ? Math.round(noise(`lo${s.id}`) * 9)
        : s.status === "new"
          ? 3
          : s.status === "dormant"
            ? 34 + Math.round(noise(`do${s.id}`) * 20)
            : s.status === "lost"
              ? 96 + Math.round(noise(`lo${s.id}`) * 40)
              : null;
    const ar = s.creditLimit
      ? Math.round(s.creditLimit * (0.15 + noise(`ar${s.id}`) * 0.7))
      : null;
    return {
      storeId: s.id,
      code: s.code,
      name: s.name,
      channel: channelLabel(s.agent.channel),
      territory: territoryLabel(s.agent.territory),
      status: s.status,
      salesPeriod: s.status === "active" || s.status === "new" ? period : 0,
      salesPrior: s.status === "new" ? null : s.status === "never" ? 0 : prior,
      deltaPct: s.status === "active" ? deltaPct(period, prior) : null,
      lastOrderAt:
        daysSince === null ? null : clock.now - daysSince * 86_400_000,
      lastVisitAt:
        s.status === "never"
          ? null
          : clock.now -
            Math.round(noise(`lv${s.id}`) * (s.status === "lost" ? 40 : 8)) *
              86_400_000,
      skuCount:
        s.status === "never"
          ? 0
          : 3 +
            Math.round(
              noise(`sk${s.id}`) *
                (s.agent.channel === "kas" || s.agent.channel === "mt"
                  ? 30
                  : 12),
            ),
      mustSellGaps:
        s.status === "never" ? 8 : Math.round(noise(`ms${s.id}`) * 5),
      arBalance: ar,
    };
  });
}

function stores(query: Query, clock: Clock): StoresResponse {
  const head = header(query, clock);
  const all = storeRows(query, clock, head);
  const status = query.status as StoreStatus | undefined;
  const q = query.q?.toLowerCase().trim();
  const list = all
    .filter((r) => !status || r.status === status)
    .filter(
      (r) =>
        !q ||
        r.name.toLowerCase().includes(q) ||
        r.code.toLowerCase().includes(q),
    )
    .sort(
      (a, b) => b.salesPeriod - a.salesPeriod || a.name.localeCompare(b.name),
    );
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.cursor) || 0);
  const count = (s: StoreStatus) => all.filter((r) => r.status === s).length;
  const ubo = all.filter((r) => r.salesPeriod > 0).length;
  const weeks: StoresResponse["uboTrend"] = [];
  const end = head.period.to;
  const monday = addDays(
    end,
    -((new Date(`${end}T00:00:00Z`).getUTCDay() + 6) % 7),
  );
  for (let i = 7; i >= 0; i--) {
    const w = addDays(monday, -7 * i);
    weeks.push({
      weekStart: w,
      ubo: Math.round(ubo * (0.62 + noise(`ubo${w}`) * 0.12)),
    });
  }
  return {
    ...head,
    kpis: [
      kpi("universe", "Store universe", "count", all.length, {
        prior: all.length - 4,
        status: "ok",
        definition: "Active stores in scope on the master list, buying or not.",
      }),
      kpi("activeBuying", "Buying this period", "count", ubo, {
        prior: Math.round(ubo * 0.97),
        target: Math.round(all.length * 0.8),
        definition:
          "Stores with at least one order that counts as sales in the period.",
      }),
      kpi("ubo", "Buying rate (UBO)", "pct", pctOf(ubo, all.length), {
        target: 80,
        prior: 68.3,
        definition: "Buying stores out of the store universe.",
      }),
      kpi("newStores", "New stores", "count", count("new"), {
        prior: 9,
        status: "ok",
        definition: "Stores whose first order fell in the period.",
      }),
      kpi("lostStores", "Lost stores", "count", count("lost"), {
        prior: 14,
        status: count("lost") > 15 ? "behind" : "watch",
        definition: "Stores that used to buy and have not ordered in 90 days.",
      }),
      kpi("dormant", "Dormant stores", "count", count("dormant"), {
        prior: 31,
        status: "watch",
        definition: "Stores with no order in the last 30 to 89 days.",
      }),
    ],
    uboTrend: weeks,
    rows: list.slice(offset, offset + limit),
    next: offset + limit < list.length ? String(offset + limit) : null,
  };
}

function store(query: Query, clock: Clock): StoreResponse {
  const s = STORES.find((st) => st.id === query.storeId) ?? STORES[0]!;
  const head = header(query, clock);
  const row = storeRows({}, clock, head).find((r) => r.storeId === s.id)!;
  const weeks: StoreResponse["salesTrend"] = [];
  const end = head.period.to;
  const monday = addDays(
    end,
    -((new Date(`${end}T00:00:00Z`).getUTCDay() + 6) % 7),
  );
  const share = storeShare(s);
  for (let i = 11; i >= 0; i--) {
    const w = addDays(monday, -7 * i);
    const value = Math.round(
      sumSales([s.agent], w, addDays(w, 6), clock) * share,
    );
    weeks.push({
      weekStart: w,
      sales: s.status === "lost" && i < 4 ? 0 : value,
    });
  }
  const visits: StoreResponse["visits"] = Array.from({ length: 10 }, (_, i) => {
    const r = noise(`sv${s.id}${i}`);
    return {
      at: at(
        addDays(clock.today, -i * 3 - 1),
        9 + Math.round(r * 6),
        Math.round(r * 59),
      ),
      agent: s.agent.name,
      productive: r < 0.7,
      outcome:
        r < 0.7
          ? "Order taken"
          : r < 0.85
            ? "No order: stock still on shelf"
            : "Owner not around",
      onPlan: r > 0.08,
    };
  });
  const orders: StoreResponse["orders"] = visits
    .filter((v) => v.productive)
    .map((v, i) => ({
      orderId: `ord-${s.id}-${i}`,
      number: `SO-${10_480 - i * 13 - (hash(s.id) % 50)}`,
      at: v.at + 10 * 60_000,
      status: i === 0 ? "pending_approval" : i < 3 ? "approved" : "posted",
      totalCentavos:
        Math.round(
          (DROP[s.agent.channel]! * (0.6 + noise(`so${s.id}${i}`) * 0.9)) / 100,
        ) * 100,
      lines: 3 + Math.round(noise(`sl${i}`) * 6),
    }));
  const assortment = SKUS.slice(0, 16).map((sku, i) => {
    const r = noise(`as${s.id}${sku.id}`);
    return {
      productId: sku.id,
      code: sku.code,
      name: sku.name,
      lastBoughtAt:
        r < 0.65 ? clock.now - Math.round(r * 40) * 86_400_000 : null,
      onShelf: i % 5 === 4 ? null : r < 0.65 ? r > 0.08 : false,
    };
  });
  return {
    ...head,
    store: {
      storeId: s.id,
      code: s.code,
      name: s.name,
      channel: channelLabel(s.agent.channel),
      territory: territoryLabel(s.agent.territory),
      agent: s.agent.name,
      address: `${BARANGAYS[s.agent.territory]![hash(s.id) % 6]}, Cebu`,
      status: s.status,
      creditLimit: s.creditLimit,
    },
    kpis: [
      kpi("salesPeriod", "Sales this period", "php", row.salesPeriod, {
        prior: row.salesPrior,
        status: row.deltaPct !== null && row.deltaPct < -10 ? "behind" : "ok",
        definition: SALES_DEF,
      }),
      kpi("visitsPeriod", "Visits", "count", 6, {
        target: 8,
        prior: 7,
        definition:
          "Check-ins at this store in the period against its MCP frequency.",
      }),
      kpi(
        "avgDrop",
        "Average drop",
        "php",
        orders.length
          ? Math.round(
              orders.reduce((x, o) => x + o.totalCentavos, 0) / orders.length,
            )
          : null,
        {
          prior: DROP[s.agent.channel]!,
          status: "ok",
          definition: "Average value of one order from this store.",
        },
      ),
      kpi("skuCount", "Products bought", "count", row.skuCount, {
        target: 16,
        prior: Math.max(0, row.skuCount - 1),
        definition:
          "Different products bought in the last 90 days, against the must-sell list.",
      }),
      kpi("osa", "On-shelf availability", "pct", null, {
        definition:
          "Must-sell products found on the shelf at the last audit. No shelf audit was recorded in the period.",
      }),
      kpi("arBalance", "Open balance", "php", row.arBalance, {
        target: s.creditLimit,
        status:
          row.arBalance !== null &&
          s.creditLimit !== null &&
          row.arBalance > s.creditLimit * 0.8
            ? "watch"
            : row.arBalance === null
              ? "unknown"
              : "ok",
        definition:
          "Unpaid invoices for this store's account. Target shows the credit limit.",
      }),
    ],
    salesTrend: weeks,
    visits,
    orders,
    assortment,
    suggestedOrder: assortment
      .filter((a) => a.onShelf === false || a.lastBoughtAt === null)
      .slice(0, 5)
      .map((a, i) => ({
        productId: a.productId,
        qtyCases: 1 + (i % 3),
        reason:
          a.lastBoughtAt === null
            ? "Must-sell product never bought here"
            : "Out on the shelf at the last visit",
      })),
  };
}

/** Dev fixture for /inventory/valuation, built from the analytics stock fixture so both pages agree. */
export function valuationFromStock(data: StockResponse): ValuationResponse {
  const rows = data.rows.map((r) => ({
    productId: r.productId,
    code: r.code,
    name: r.name,
    category: r.category,
    locationId: "fixture-depot",
    locationName: "Main depot",
    onHand: {
      base: r.onHand.cases * 24 + r.onHand.pieces,
      cases: r.onHand.cases,
      pieces: r.onHand.pieces,
      display: r.onHand.display,
      valueCentavos: r.valueCentavos,
    },
    available: {
      base: r.onHand.cases * 24 + r.onHand.pieces,
      cases: r.onHand.cases,
      pieces: r.onHand.pieces,
      display: r.onHand.display,
      valueCentavos: r.valueCentavos,
    },
    costValueCentavos: r.valueCentavos ?? 0,
    costKnown: r.valueCentavos !== null,
    sellingValueCentavos:
      r.valueCentavos === null ? null : Math.round(r.valueCentavos / 0.78),
  }));
  return {
    asOf: data.freshness.asOf,
    basis: "cost",
    groupBy: "product",
    valueLabel: "Cost value",
    secondaryValueLabel: "Selling value",
    rows,
    totals: {
      costValueCentavos: rows.reduce((n, r) => n + r.costValueCentavos, 0),
      sellingValueCentavos: rows.reduce(
        (n, r) => n + (r.sellingValueCentavos ?? 0),
        0,
      ),
      rowsWithoutCost: rows.filter((r) => !r.costKnown).length,
      rowsWithoutPrice: rows.filter((r) => r.sellingValueCentavos === null)
        .length,
    },
  };
}

// ---------- /stock ----------
function stock(query: Query, clock: Clock): StockResponse {
  const head = header(query, clock);
  const rows: StockResponse["rows"] = SKUS.map((sku, i) => {
    const sold = round1(
      ((sku.weight / SKU_WEIGHT_TOTAL) *
        sumSales(AGENTS, addDays(clock.today, -27), clock.today, clock)) /
        100 /
        sku.casePrice /
        24,
    );
    const r = noise(`stk${sku.id}`);
    const out = i === 0 || i === 5 || i === 31;
    const cover = out
      ? 0
      : i === 4 || i === 12
        ? 2 + r * 2
        : i === 37
          ? 58
          : 7 + r * 25;
    const totalPieces = Math.round(cover * sold * sku.pcsPerCase);
    const cases = Math.floor(totalPieces / sku.pcsPerCase);
    const pieces = totalPieces % sku.pcsPerCase;
    const status = out
      ? "out"
      : cover < 5
        ? "low"
        : cover > 45
          ? "overstock"
          : "ok";
    return {
      productId: sku.id,
      code: sku.code,
      name: sku.name,
      category: sku.category,
      onHand: {
        cases,
        pieces,
        display: pieces ? `${cases} cs ${pieces} pc` : `${cases} cs`,
      },
      valueCentavos: Math.round(
        (totalPieces / sku.pcsPerCase) * sku.casePrice * 100 * 0.78,
      ),
      avgDailySalesCases: sold,
      daysCover: out ? 0 : round1(cover),
      numericDistributionPct: null, // No physical observation in a sales-only fixture.
      buyingReachPct: round1(38 + r * 50),
      oosStores: out ? 14 - (i % 4) : Math.round(r * 4),
      status,
    };
  });
  rows.sort((a, b) => (a.daysCover ?? 999) - (b.daysCover ?? 999));
  const value = rows.reduce((s, r) => s + (r.valueCentavos ?? 0), 0);
  const cases = rows.reduce((s, r) => s + r.onHand.cases, 0);
  const avgCover = round1(
    rows.reduce((s, r) => s + (r.daysCover ?? 0), 0) / rows.length,
  );
  return {
    ...head,
    kpis: [
      kpi("stockValue", "Stock value", "php", value, {
        prior: Math.round(value * 1.07),
        status: "ok",
        definition:
          "On-hand quantity in every location valued at standard cost.",
      }),
      kpi(
        "skusOutAtDepot",
        "Products out at depot",
        "count",
        rows.filter((r) => r.status === "out").length,
        {
          target: 0,
          prior: 1,
          status: "behind",
          definition:
            "Active products with zero sellable stock at the main depot.",
        },
      ),
      kpi(
        "lowStock",
        "Low stock",
        "count",
        rows.filter((r) => r.status === "low").length,
        {
          prior: 3,
          status: "watch",
          definition:
            "Products with less than 5 days of cover at the current selling rate.",
        },
      ),
      kpi("daysCover", "Days of cover", "count", avgCover, {
        target: 14,
        prior: 16.2,
        status: avgCover < 12 ? "watch" : "ok",
        definition:
          "On-hand cases divided by average daily sales in cases over the last 28 days.",
      }),
      kpi("nearExpiry", "Near expiry", "cases", null, {
        definition:
          "Cases expiring within 60 days. Batch and expiry dates are not recorded yet for these products.",
      }),
      kpi("badOrders", "Bad orders", "cases", 37, {
        prior: 29,
        status: "watch",
        definition:
          "Damaged or expired returns received in the period, in cases.",
      }),
    ],
    locations: [
      {
        locationId: "loc-depot",
        label: "Mandaue depot",
        kind: "depot",
        valueCentavos: Math.round(value * 0.86),
        cases: Math.round(cases * 0.86),
      },
      {
        locationId: "loc-van1",
        label: "Van 1 · GAB 4127",
        kind: "truck",
        valueCentavos: Math.round(value * 0.06),
        cases: Math.round(cases * 0.06),
      },
      {
        locationId: "loc-van2",
        label: "Van 2 · NFK 2093",
        kind: "truck",
        valueCentavos: Math.round(value * 0.05),
        cases: Math.round(cases * 0.05),
      },
      {
        locationId: "loc-bo",
        label: "Bad-order bay",
        kind: "other",
        valueCentavos: null,
        cases: 37,
      },
    ],
    rows,
  };
}

// ---------- /vans ----------
function vanRows(
  date: string,
  clock: Clock,
  query: Query,
): VansResponse["rows"] {
  const agents = new Set(scopedAgents(query).map((a) => a.id));
  const vans = AGENTS.filter((a) => a.channel === "van" && agents.has(a.id));
  return vans.map((agent, i) => {
    const salesCentavos = agentDaySales(agent, date, clock);
    const loaded = 180 + i * 24;
    const sold = Math.round(salesCentavos / 100 / 2_350);
    const returned =
      date < clock.today || i === 1 ? loaded - sold - (i === 1 ? 2 : 0) : null;
    const expected = Math.round(salesCentavos * 0.82);
    const short = i === 1 ? -184_050 : 0;
    const status =
      date < clock.today ? "settled" : i === 0 ? "on_route" : "returned";
    return {
      tripId: `trip-${date}-${i + 1}`,
      truck: i === 0 ? "Van 1 · GAB 4127" : "Van 2 · NFK 2093",
      seller: agent.name,
      status: (date < clock.today && i === 1
        ? "unclosed"
        : status) as VansResponse["rows"][number]["status"],
      loadedCases: loaded,
      soldCases: sold,
      returnedCases: returned,
      stockVarianceCases: returned === null ? null : loaded - sold - returned,
      salesCentavos,
      cashExpected: expected,
      cashRemitted: status === "on_route" ? null : expected + short,
      variance: status === "on_route" ? null : short,
      voids: i === 1 ? 2 : 0,
      discountsCentavos: i === 1 ? 1_240_00 : 380_00,
      closedAt: status === "on_route" ? null : at(date, 17, 42),
    };
  });
}

function vans(query: Query, clock: Clock): VansResponse {
  const date = isIsoDate(query.date) ? query.date : clock.today;
  const head = header({ ...query, date }, clock, { from: date, to: date });
  const rows = vanRows(date, clock, query);
  const sum = (pick: (r: (typeof rows)[number]) => number | null) =>
    rows.reduce((s, r) => s + (pick(r) ?? 0), 0);
  const variance = sum((r) => r.variance);
  return {
    ...head,
    kpis: [
      kpi("tripsOut", "Trips today", "count", rows.length, {
        prior: 2,
        status: "ok",
        definition: "Van trips loaded on the day, closed or not.",
      }),
      kpi(
        "salesCentavos",
        "Van sales",
        "php",
        sum((r) => r.salesCentavos),
        {
          target: sumTarget(
            AGENTS.filter((a) => a.channel === "van"),
            date,
            date,
          ),
          prior: sumSales(
            AGENTS.filter((a) => a.channel === "van"),
            addDays(date, -1),
            addDays(date, -1),
            clock,
          ),
          definition: "Net value of van receipts, counted on sale.",
        },
      ),
      kpi(
        "cashExpected",
        "Cash expected",
        "php",
        sum((r) => r.cashExpected),
        {
          status: "ok",
          definition:
            "Cash sales plus collections minus approved expenses for returned trips.",
        },
      ),
      kpi(
        "cashRemitted",
        "Cash remitted",
        "php",
        sum((r) => r.cashRemitted),
        {
          status: "ok",
          definition: "Cash counted and accepted at remittance.",
        },
      ),
      kpi("cashVariance", "Cash variance", "php", variance, {
        status: variance < 0 ? "behind" : "ok",
        definition: "Cash remitted minus cash expected. Negative means short.",
      }),
      kpi(
        "stockVarianceCases",
        "Stock variance",
        "cases",
        sum((r) => r.stockVarianceCases),
        {
          status: sum((r) => r.stockVarianceCases) ? "watch" : "ok",
          definition:
            "Loaded minus sold minus returned cases. Anything but zero is unexplained.",
        },
      ),
    ],
    rows,
  };
}

// ---------- /money ----------
function money(query: Query, clock: Clock): MoneyResponse {
  const head = header(query, clock);
  const agents = new Set(scopedAgents(query).map((a) => a.id));
  const accounts = STORES.filter(
    (s) =>
      s.creditLimit !== null && agents.has(s.agent.id) && s.status !== "never",
  ).slice(0, 48);
  const rows: MoneyResponse["rows"] = accounts
    .map((s) => {
      const r = noise(`m${s.id}`);
      const balance =
        Math.round(((s.creditLimit ?? 0) * (0.2 + r * 0.85)) / 100) * 100;
      const split = [0.52, 0.24, 0.12, 0.07, 0.05].map(
        (w, i) => w * (0.6 + noise(`ms${s.id}${i}`) * 0.8),
      );
      const total = split.reduce((x, y) => x + y, 0);
      const parts = split.map(
        (w) => Math.round((balance * w) / total / 100) * 100,
      );
      parts[0] = balance - parts.slice(1).reduce((x, y) => x + y, 0);
      const over = s.creditLimit !== null && balance > s.creditLimit;
      const overdue = parts[2]! + parts[3]! + parts[4]! > balance * 0.25;
      return {
        accountId: `acc-${s.id}`,
        code: s.code,
        name: s.name,
        channel: channelLabel(s.agent.channel),
        agent: s.agent.name,
        balance,
        current: parts[0]!,
        d1_30: parts[1]!,
        d31_60: parts[2]!,
        d61_90: parts[3]!,
        d90p: parts[4]!,
        creditLimit: s.creditLimit,
        lastPaymentAt: clock.now - Math.round(r * 50) * 86_400_000,
        status: over ? "over_limit" : overdue ? "overdue" : "current",
      };
    })
    .sort((a, b) => b.d90p + b.d61_90 - (a.d90p + a.d61_90));
  const sum = (k: keyof MoneyResponse["aging"]) =>
    rows.reduce((s, r) => s + r[k], 0);
  const aging = {
    current: sum("current"),
    d1_30: sum("d1_30"),
    d31_60: sum("d31_60"),
    d61_90: sum("d61_90"),
    d90p: sum("d90p"),
  };
  const ar = rows.reduce((s, r) => s + r.balance, 0);
  const overdue = aging.d31_60 + aging.d61_90 + aging.d90p;
  const scopeAgents = scopedAgents(query);
  return {
    ...head,
    kpis: [
      kpi(
        "collectionsToday",
        "Collected today",
        "php",
        Math.round(
          sumSales(scopeAgents, clock.today, clock.today, clock) * 0.41,
        ),
        {
          prior: Math.round(
            sumSales(
              scopeAgents,
              addDays(clock.today, -1),
              addDays(clock.today, -1),
              clock,
            ) * 0.44,
          ),
          status: "unknown",
          definition:
            "Cash and cheques recorded as collected today. No collection target is set yet.",
        },
      ),
      kpi(
        "collectionsMtd",
        "Collected this month",
        "php",
        Math.round(
          sumSales(
            scopeAgents,
            `${clock.today.slice(0, 7)}-01`,
            clock.today,
            clock,
          ) * 0.78,
        ),
        {
          prior: Math.round(
            sumSales(
              scopeAgents,
              `${clock.today.slice(0, 7)}-01`,
              clock.today,
              clock,
            ) * 0.74,
          ),
          status: "unknown",
          definition: "Collections recorded since the 1st of the month.",
        },
      ),
      kpi("arTotal", "Open receivables", "php", ar, {
        prior: Math.round(ar * 0.96),
        status: "ok",
        definition: "Unpaid invoice balances for every account in scope.",
      }),
      kpi("overdue", "Overdue over 30 days", "php", overdue, {
        target: Math.round(ar * 0.15),
        prior: Math.round(overdue * 0.91),
        status: overdue > ar * 0.2 ? "behind" : "watch",
        definition:
          "Balances more than 30 days past the invoice due date. Target is at most 15% of receivables.",
      }),
      kpi(
        "creditBreaches",
        "Over credit limit",
        "count",
        rows.filter((r) => r.status === "over_limit").length,
        {
          target: 0,
          prior: 3,
          status: rows.some((r) => r.status === "over_limit") ? "behind" : "ok",
          definition:
            "Accounts whose open balance is above their credit limit.",
        },
      ),
      kpi("heldOrders", "Orders on credit hold", "count", 4, {
        prior: 2,
        status: "watch",
        definition:
          "Orders waiting because the account is over its limit or overdue.",
      }),
    ],
    aging,
    rows,
  };
}

// ---------- /exceptions ----------
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;
function bySeverity(a: ExceptionItem, b: ExceptionItem) {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    a.openedAt - b.openedAt
  );
}

function allExceptions(clock: Clock, date = clock.today): ExceptionItem[] {
  const ago = (minutes: number) => clock.now - minutes * 60_000;
  const owner = (s: keyof typeof SUPERVISORS) => SUPERVISORS[s];
  const tmg = AGENTS.filter((a) => a.territory === "t-tmg");
  const monthStart = `${date.slice(0, 7)}-01`;
  const tmgSales = sumSales(tmg, monthStart, date, clock);
  const tmgDue = sumTarget(tmg, monthStart, date) ?? 1;
  const gaisano = STORES.find((s) => s.name.startsWith("Gaisano Grand"))!;
  const robinsons = STORES.find((s) => s.name.startsWith("Robinsons"))!;
  const items: ExceptionItem[] = [
    {
      id: "ex-01",
      kind: "cash_variance",
      severity: "high",
      title: "Van 2 is short ₱1,840.50",
      detail:
        "Nestor Cañete remitted ₱1,840.50 less than expected for today's trip.",
      subject: { type: "van", id: "trip-2", label: "Van 2 · NFK 2093" },
      owner: owner("s2"),
      dueAt: at(date, 18),
      openedAt: ago(42),
      evidence: { expected: 4_120_350, remitted: 4_101_945 },
      action: { label: "Review remittance", href: "/workflows?trip=trip-2" },
    },
    {
      id: "ex-02",
      kind: "behind_target",
      severity: "high",
      title: `Talisay – Minglanilla at ${Math.round((tmgSales / tmgDue) * 100)}% of pace`,
      detail: `${formatPhp(tmgSales)} sold against ${formatPhp(tmgDue)} expected by today.`,
      subject: {
        type: "territory",
        id: "t-tmg",
        label: "Talisay – Minglanilla",
      },
      owner: owner("s2"),
      dueAt: null,
      openedAt: ago(60 * 26),
      evidence: {},
      action: {
        label: "See agents",
        href: "/sales?groupBy=agent&parent=territory%3At-tmg&crumb=agent~territory%3At-tmg~Talisay%20%E2%80%93%20Minglanilla",
      },
    },
    {
      id: "ex-03",
      kind: "not_started",
      severity: "high",
      title: "Marites Lim has not started",
      detail:
        "30 stops planned today. No check-in since the phone last synced at 7:52 AM.",
      subject: { type: "agent", id: "p11", label: "Marites Lim" },
      owner: owner("s2"),
      dueAt: at(date, 10),
      openedAt: ago(140),
      evidence: {},
      action: {
        label: "Open her day",
        href: `/coverage-people/agent?profileId=p11&date=${date}`,
      },
    },
    {
      id: "ex-04",
      kind: "van_unclosed",
      severity: "high",
      title: "Van 1 trip from Saturday is not closed",
      detail: "Rogelio Uy's Oct 17 trip has no returned stock count.",
      subject: { type: "van", id: "trip-0", label: "Van 1 · GAB 4127" },
      owner: owner("s1"),
      dueAt: at(addDays(date, -1), 20),
      openedAt: ago(60 * 38),
      evidence: {},
      action: { label: "Close the trip", href: "/van-trips?trip=trip-0" },
    },
    {
      id: "ex-05",
      kind: "credit_breach",
      severity: "high",
      title: `${gaisano.name} over limit by ₱182,400`,
      detail:
        "Balance ₱532,400 on a ₱350,000 limit. One order of ₱86,420 is held.",
      subject: { type: "store", id: gaisano.id, label: gaisano.name },
      owner: owner("s1"),
      dueAt: null,
      openedAt: ago(60 * 5),
      evidence: {},
      action: {
        label: "Decide held order",
        href: "/workflows?order=ord-10482",
      },
    },
    {
      id: "ex-06",
      kind: "order_approval",
      severity: "medium",
      title: "Order SO-10482 waiting 5 h",
      detail: `${gaisano.name} · ₱86,420 · 14 lines.`,
      subject: { type: "order", id: "ord-10482", label: "SO-10482" },
      owner: owner("s1"),
      dueAt: at(date, 17),
      openedAt: ago(300),
      evidence: {},
      action: {
        label: "Approve or reject",
        href: "/workflows?order=ord-10482",
      },
    },
    {
      id: "ex-07",
      kind: "order_approval",
      severity: "medium",
      title: "Order SO-10477 waiting 3 h",
      detail: `${robinsons.name} · ₱64,980 · 11 lines.`,
      subject: { type: "order", id: "ord-10477", label: "SO-10477" },
      owner: owner("s2"),
      dueAt: at(date, 17),
      openedAt: ago(185),
      evidence: {},
      action: {
        label: "Approve or reject",
        href: "/workflows?order=ord-10477",
      },
    },
    {
      id: "ex-08",
      kind: "order_approval",
      severity: "low",
      title: "Order SO-10490 waiting 40 min",
      detail: "Metro Supermarket Mandaue · ₱38,250 · 9 lines.",
      subject: { type: "order", id: "ord-10490", label: "SO-10490" },
      owner: owner("s1"),
      dueAt: at(date, 17),
      openedAt: ago(40),
      evidence: {},
      action: {
        label: "Approve or reject",
        href: "/workflows?order=ord-10490",
      },
    },
    {
      id: "ex-09",
      kind: "missed_stops",
      severity: "medium",
      title: "Carlo Alcoseba missed 10 of 28 stops on Saturday",
      detail: "Third week in a row under 70% compliance.",
      subject: { type: "agent", id: "p10", label: "Carlo Alcoseba" },
      owner: owner("s2"),
      dueAt: null,
      openedAt: ago(60 * 40),
      evidence: {},
      action: {
        label: "Open his day",
        href: `/coverage-people/agent?profileId=p10&date=${addDays(date, -2)}`,
      },
    },
    {
      id: "ex-10",
      kind: "oos_hotspot",
      severity: "medium",
      title: "Premium Corned Beef 150g out at 14 stores",
      detail:
        "Also out at the Mandaue depot. 9 of the stores are in Cebu City North.",
      subject: {
        type: "sku",
        id: "sku01",
        label: "Sunpride Premium Corned Beef 150g",
      },
      owner: null,
      dueAt: null,
      openedAt: ago(60 * 20),
      evidence: {},
      action: { label: "See stock", href: "/stock" },
    },
    {
      id: "ex-11",
      kind: "stock_variance",
      severity: "medium",
      title: "Depot count is 6 cs short",
      detail: "Holiday Luncheon Meat 340g: counted 112 cs, expected 118 cs.",
      subject: {
        type: "sku",
        id: "sku05",
        label: "Holiday Luncheon Meat 340g",
      },
      owner: null,
      dueAt: null,
      openedAt: ago(60 * 9),
      evidence: {},
      action: { label: "Review count", href: "/inventory" },
    },
    {
      id: "ex-12",
      kind: "mcp_approval",
      severity: "medium",
      title: "November MCP for Rhea Pepito waiting approval",
      detail: "Submitted Oct 16. 612 stops across 26 selling days.",
      subject: { type: "agent", id: "p08", label: "Rhea Pepito" },
      owner: owner("s1"),
      dueAt: at(addDays(date, 6), 17),
      openedAt: ago(60 * 70),
      evidence: {},
      action: { label: "Review plan", href: "/sales-force" },
    },
    {
      id: "ex-13",
      kind: "idle_agent",
      severity: "medium",
      title: "Paolo Abella idle for 74 min",
      detail:
        "Last check-out at Carbon Market Stall, Lahug. No movement since.",
      subject: { type: "agent", id: "p03", label: "Paolo Abella" },
      owner: owner("s1"),
      dueAt: null,
      openedAt: ago(74),
      evidence: {},
      action: {
        label: "Open his day",
        href: `/coverage-people/agent?profileId=p03&date=${date}`,
      },
    },
    {
      id: "ex-14",
      kind: "location_issue",
      severity: "low",
      title: "Check-in 1.4 km from the store pin",
      detail: "Kevin Rama at Aling Nena Store, Tabunok.",
      subject: {
        type: "store",
        id: "st300",
        label: "Aling Nena Store, Tabunok",
      },
      owner: owner("s2"),
      dueAt: null,
      openedAt: ago(95),
      evidence: { distanceM: 1400 },
      action: { label: "Decide", href: "/supervision" },
    },
    {
      id: "ex-15",
      kind: "talk_sheet_overdue",
      severity: "low",
      title: "2 Talk Sheet actions overdue",
      detail: "From Edgar Rosales's Work-With with Joy Villanueva on Oct 9.",
      subject: { type: "agent", id: "p02", label: "Joy Villanueva" },
      owner: owner("s1"),
      dueAt: at(addDays(date, -3), 17),
      openedAt: ago(60 * 72),
      evidence: {},
      action: { label: "Open Talk Sheet", href: "/supervision" },
    },
    {
      id: "ex-16",
      kind: "per_diem_review",
      severity: "low",
      title: "Per diem for Oct 1–15 needs review",
      detail: "11 people, 4 days with fewer valid calls than the minimum.",
      subject: { type: "territory", id: "t-ccs", label: "Cebu City South" },
      owner: owner("s2"),
      dueAt: at(addDays(date, 2), 17),
      openedAt: ago(60 * 50),
      evidence: {},
      action: { label: "Review per diem", href: "/supervision" },
    },
    {
      id: "ex-17",
      kind: "new_store",
      severity: "low",
      title: "New store waiting: Nanay Ising Store, Basak",
      detail: "Enrolled by Mark Ybañez with a photo and a pin.",
      subject: {
        type: "store",
        id: "st-new-1",
        label: "Nanay Ising Store, Basak",
      },
      owner: owner("s2"),
      dueAt: null,
      openedAt: ago(60 * 7),
      evidence: {},
      action: { label: "Approve store", href: "/sales-force" },
    },
    {
      id: "ex-18",
      kind: "dormant_key_store",
      severity: "medium",
      title: `${robinsons.name}: no order in 21 days`,
      detail: "Usually orders weekly, about ₱62,000 a drop.",
      subject: { type: "store", id: robinsons.id, label: robinsons.name },
      owner: owner("s2"),
      dueAt: null,
      openedAt: ago(60 * 24 * 4),
      evidence: {},
      action: {
        label: "Open store",
        href: `/customers/customer?storeId=${robinsons.id}`,
      },
    },
  ];
  return items;
}

function exceptions(query: Query, clock: Clock): ExceptionsResponse {
  const head = header(query, clock);
  const all = allExceptions(clock).sort(bySeverity);
  const counts: ExceptionsResponse["counts"] = {};
  for (const item of all) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  const items = all
    .filter((i) => !query.kind || i.kind === query.kind)
    .filter((i) => !query.severity || i.severity === query.severity)
    .filter(
      (i) =>
        !query.ownerProfileId || i.owner?.profileId === query.ownerProfileId,
    );
  return { ...head, counts, items, next: null };
}

// ---------- entry points ----------
const BUILDERS: {
  [P in AnalyticsPage]: (q: Query, c: Clock) => AnalyticsResponses[P];
} = {
  today,
  sales,
  coverage,
  "agent-day": agentDay,
  stores,
  store,
  stock,
  vans,
  money,
  exceptions,
};

export function analyticsFixture<P extends AnalyticsPage>(
  page: P,
  query: Query,
  now = Date.now(),
): AnalyticsResponses[P] {
  return BUILDERS[page](query, clockFor(query, now));
}

export function targetsFixture(
  month: string,
  level: TargetLevel,
): TargetsResponse {
  const from = `${month}-01`;
  const to = addDays(addDays(from, 40).slice(0, 7) + "-01", -1);
  const setAt = Date.parse(`${month}-01T09:12:00+08:00`) - 3 * 86_400_000;
  const setBy = "Francis Uy";
  const sum = (agents: Agent[]) => {
    const t = sumTarget(agents, from, to);
    return t === null ? null : Math.round(t / 100_000) * 100_000;
  };
  let rows: TargetsResponse["rows"];
  if (level === "company")
    rows = [
      {
        key: "company",
        label: "Sunpride Cebu (all channels)",
        amountCentavos: sum(AGENTS),
        setBy,
        setAt,
      },
    ];
  else if (level === "channel")
    rows = CHANNELS.map((c) => ({
      key: c.key,
      label: c.label,
      amountCentavos: sum(AGENTS.filter((a) => a.channel === c.key)),
      setBy,
      setAt,
    }));
  else if (level === "territory")
    rows = TERRITORIES.map((t) => ({
      key: t.id,
      label: t.label,
      amountCentavos: sum(AGENTS.filter((a) => a.territory === t.id)),
      setBy,
      setAt,
    }));
  else
    rows = AGENTS.map((a) => ({
      key: a.id,
      label: a.name,
      amountCentavos: a.target === null ? null : a.target * 100,
      setBy: a.target === null ? null : setBy,
      setAt: a.target === null ? null : setAt,
    }));
  return {
    month,
    level,
    rows,
    total: rows.reduce((s, r) => s + (r.amountCentavos ?? 0), 0),
  };
}

/** Fixture mode reads "now" as today at 3:05 PM Manila, mid-afternoon, so every screen has a running day. */
export function fixtureNow(now = Date.now()) {
  return at(manilaToday(now), 15, 5);
}

export function unitsFixture(): UnitOption[] {
  return UNITS;
}

/** The fixture people, for tests that need a profile id. */
export const FIXTURE_AGENTS = AGENTS.map((a) => ({ id: a.id, name: a.name }));
