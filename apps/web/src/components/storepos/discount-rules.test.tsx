import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
  useApi: () => ({ data: undefined }),
  useLive: () => {},
  mutate: vi.fn(),
  apiFetch: vi.fn(),
}));

import {
  CardLookup,
  DEFAULT_WORDS,
  LegacyZCard,
  RefundPolicyCard,
  refundPesosToCentavos,
  type RefundPolicyData,
  WeeklyLimitCard,
  PrivilegeSwitchCard,
  privilegeState,
  type PrivilegeSettingsData,
  limitStatusWords,
  pesosToCentavos,
  peso,
  type CapData,
  type LegacyZData,
  type LegacyZDevice,
} from "./discount-rules";

const html = (node: React.ReactNode) => renderToStaticMarkup(node as never);

const cap = (over: Partial<CapData> = {}, setting: Partial<CapData["setting"]> = {}): CapData => ({
  setting: {
    enabled: true,
    capCentavos: 250000,
    accountantConfirmed: false,
    isDefault: true,
    note: DEFAULT_WORDS,
    effectiveFrom: null,
    ...setting,
  },
  week: { start: "2026-11-02", endsAt: Date.parse("2026-11-08T16:00:00Z"), note: "Monday to Sunday, Manila time" },
  appliesTo: ["senior", "pwd"],
  history: [],
  card: null,
  canManage: true,
  ...over,
});
const device = (over: Partial<LegacyZDevice> = {}): LegacyZDevice => ({
  deviceId: "d1",
  tag: "H10-01",
  person: "Ana Cruz",
  store: "Colon store",
  register: "Till 1",
  buildCode: 29,
  buildName: "1.0.0-beta.29",
  lastSeenAt: Date.parse("2026-11-06T02:00:00Z"),
  quiet: false,
  state: "older",
  stateWords: "Older build (beta.29)",
  needsUpdate: true,
  lastLegacyZ: Date.parse("2026-11-05T10:00:00Z"),
  legacyZ30d: 3,
  ...over,
});
const zdata = (over: Partial<LegacyZData> = {}): LegacyZData => ({
  gate: {
    mode: "older_builds_only",
    modeWords: "Older builds only: refused from beta.30 and later, still allowed on older or unreported builds",
    minVersionCode: 30,
    note: null,
    isDefault: true,
  },
  summary: {
    devices: 1,
    needingUpdate: 1,
    quietNeedingUpdate: 0,
    legacyZLast30Days: 3,
    safeToSwitchOff: false,
    advice: "1 till still on an older or unreported build. Update it first.",
  },
  devices: [device()],
  canManage: true,
  quietDays: 45,
  ...over,
});

describe("weekly limit setting", () => {
  it("shows the shipped amount marked as a default to confirm with the accountant", () => {
    const out = html(<WeeklyLimitCard data={cap()} />);
    expect(out).toContain("₱2,500.00 a week");
    expect(out).toContain("Default — confirm with Sunpride accountant");
    expect(out).toContain("Monday to Sunday");
    expect(out).toContain("across every store and van by ID number");
    expect(out).toContain("Save the limit");
  });
  it("stops calling it a default once the office records the accountant's confirmation", () => {
    const s = cap({}, { isDefault: false, accountantConfirmed: true, capCentavos: 130000, note: null }).setting;
    expect(limitStatusWords(s)).toBe("Confirmed with the accountant");
    const out = html(<WeeklyLimitCard data={cap({}, { isDefault: false, accountantConfirmed: true, capCentavos: 130000, note: null })} />);
    expect(out).toContain("₱1,300.00 a week");
    expect(out).not.toContain("confirm with Sunpride accountant");
  });
  it("a changed but unconfirmed amount still says so; a switched-off limit says that", () => {
    expect(limitStatusWords(cap({}, { isDefault: false, accountantConfirmed: false }).setting)).toBe(DEFAULT_WORDS);
    expect(limitStatusWords(cap({}, { enabled: false }).setting)).toBe("Weekly limit is switched off");
    expect(html(<WeeklyLimitCard data={cap({}, { enabled: false })} />)).toContain("No weekly limit");
  });
  it("a person who cannot manage sees no form", () => {
    const out = html(<WeeklyLimitCard data={cap({ canManage: false })} />);
    expect(out).not.toContain("Save the limit");
    expect(out).toContain("Only the office can change the limit.");
  });
  it("lists who changed it and when", () => {
    const out = html(
      <WeeklyLimitCard
        data={cap({ history: [{ enabled: true, capCentavos: 130000, accountantConfirmed: true, note: "Per accountant", effectiveFrom: Date.parse("2026-11-06T02:00:00Z"), setBy: "Office Admin" }] })}
      />,
    );
    expect(out).toContain("by Office Admin");
    expect(out).toContain("₱1,300.00");
    expect(out).toContain("accountant confirmed");
  });
  it("turns typed pesos into centavos and refuses nonsense", () => {
    expect(pesosToCentavos("2500")).toBe(250000);
    expect(pesosToCentavos("₱1,300.50")).toBe(130050);
    expect(pesosToCentavos("0")).toBeNull();
    expect(pesosToCentavos("abc")).toBeNull();
    expect(pesosToCentavos("12.345")).toBeNull();
    expect(pesosToCentavos("2000000")).toBeNull();
    expect(peso(130000)).toBe("₱1,300.00");
  });
});

describe("card lookup", () => {
  it("shows one ID's use and what is left", () => {
    const out = html(<CardLookup card={{ type: "senior", usedCentavos: 100000, leftCentavos: 30000, message: "Weekly limit: ₱300.00 left" }} />);
    expect(out).toContain("Used ₱1,000.00 this week. Weekly limit: ₱300.00 left");
  });
});

describe("no-PIN Z gate and old-build report", () => {
  it("lists each till with its build in words and flags the ones that need an update", () => {
    const out = html(<LegacyZCard data={zdata()} />);
    expect(out).toContain("Older build (beta.29)");
    expect(out).toContain("Needs an update");
    expect(out).toContain("Colon store");
    expect(out).toContain("1 till still on an older or unreported build");
    expect(out).toContain("Now: Older builds only");
  });
  it("says when it is safe to switch off, and warns before switching off with tills left", () => {
    const safe = zdata({
      summary: { devices: 1, needingUpdate: 0, quietNeedingUpdate: 0, legacyZLast30Days: 0, safeToSwitchOff: true, advice: "Every active till is on a build that signs the Z with a PIN and none used the old way in 30 days. It is safe to switch the old way off." },
      devices: [device({ state: "current", stateWords: "On beta.31 or later", needsUpdate: false, legacyZ30d: 0, lastLegacyZ: null })],
    });
    expect(html(<LegacyZCard data={safe} />)).toContain("safe to switch the old way off");
    expect(html(<LegacyZCard data={zdata()} />)).not.toContain("Not everything is ready");
  });
  it("marks quiet phones and unreported builds; a person who cannot manage sees no form", () => {
    const out = html(
      <LegacyZCard
        data={zdata({
          canManage: false,
          devices: [device({ state: "unknown", stateWords: "Build not reported yet", buildCode: null, quiet: true, lastSeenAt: null })],
        })}
      />,
    );
    expect(out).toContain("Build not reported yet");
    expect(out).toContain("Quiet for 45+ days");
    expect(out).toContain("never");
    expect(out).not.toContain("Switch it off for every till");
    expect(out).toContain("Only the office can change this.");
  });
  it("offers the two choices and the first PIN build to the office", () => {
    const out = html(<LegacyZCard data={zdata()} />);
    expect(out).toContain("Allow it only on older builds");
    expect(out).toContain("Switch it off for every till");
    expect(out).toContain("First build that can use a PIN");
  });
});

const refundData = (over: Partial<RefundPolicyData> = {}): RefundPolicyData => ({
  supervisorOverCentavos: 50000,
  isDefault: true,
  updatedAt: null,
  updatedBy: null,
  canManage: true,
  ...over,
});

describe("refund approval amount", () => {
  it("shows the shipped amount as a default and offers the form to the office", () => {
    const out = html(<RefundPolicyCard data={refundData()} />);
    expect(out).toContain("Above ₱500.00");
    expect(out).toContain("Default — confirm with Sunpride");
    expect(out).toContain("already had refunded");
    expect(out).toContain("Save the refund amount");
  });
  it("says who set it once the office changed it; 0 means every refund", () => {
    const out = html(<RefundPolicyCard data={refundData({ isDefault: false, updatedBy: "Office Admin", updatedAt: Date.parse("2026-11-06T02:00:00Z"), supervisorOverCentavos: 0 })} />);
    expect(out).toContain("Every refund needs a supervisor");
    expect(out).toContain("Set by Office Admin");
  });
  it("a person who cannot manage sees no form", () => {
    const out = html(<RefundPolicyCard data={refundData({ canManage: false })} />);
    expect(out).not.toContain("Save the refund amount");
    expect(out).toContain("Only the office can change the refund amount.");
  });
  it("turns typed pesos into centavos, allows 0 and refuses nonsense", () => {
    expect(refundPesosToCentavos("500")).toBe(50000);
    expect(refundPesosToCentavos("₱1,250.50")).toBe(125050);
    expect(refundPesosToCentavos("0")).toBe(0);
    expect(refundPesosToCentavos("-5")).toBeNull();
    expect(refundPesosToCentavos("abc")).toBeNull();
    expect(refundPesosToCentavos("2000000")).toBeNull();
  });
});

describe("SC/PWD on/off per unit (van and store)", () => {
  const units = [{ id: "u1", name: "Cebu depot" }];
  const data = (over: Partial<PrivilegeSettingsData> = {}): PrivilegeSettingsData => ({
    settings: [],
    defaults: { store: true, van: false },
    canManage: true,
    ...over,
  });
  it("shows the spec defaults (stores on, vans off) with a switch for the office", () => {
    const out = html(<PrivilegeSwitchCard data={data()} units={units} onSave={() => {}} />);
    expect(out).toContain("Senior citizen / PWD discount on or off");
    expect(out).toContain("required by law");
    expect(out).toMatch(/privilege-store"[^>]*>On \(default\)/);
    expect(out).toMatch(/privilege-van"[^>]*>Off \(default\)/);
    expect(out).toContain("Switch on for vans");
    expect(out).toContain("Switch off for stores");
  });
  it("the newest unit-wide row in force wins; route rows and future rows do not", () => {
    const now = Date.parse("2026-11-13T00:00:00Z");
    const d = data({
      settings: [
        { id: "a", org_unit_id: "u1", surface: "van", route_id: null, enabled: true, effective_from: "2026-11-10T00:00:00Z" },
        { id: "b", org_unit_id: "u1", surface: "van", route_id: "r1", enabled: false, effective_from: "2026-11-12T00:00:00Z" },
        { id: "c", org_unit_id: "u1", surface: "van", route_id: null, enabled: false, effective_from: "2026-12-01T00:00:00Z" },
      ],
    });
    expect(privilegeState(d, "u1", "van", now)).toEqual({ enabled: true, isDefault: false });
    expect(privilegeState(d, "u1", "store", now)).toEqual({ enabled: true, isDefault: true });
  });
  it("non-admins see the state but no switch", () => {
    const out = html(<PrivilegeSwitchCard data={data({ canManage: false })} units={units} onSave={() => {}} />);
    expect(out).not.toContain("Switch on for vans");
    expect(out).toContain("Only the office can change this.");
  });
});
