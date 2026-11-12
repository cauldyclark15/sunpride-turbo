import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
  useApi: () => ({ data: undefined }),
  useLive: () => {},
  mutate: vi.fn(),
  apiFetch: vi.fn(),
}));

import { CashMovementForm, MovementsList } from "./cash-movements";
import { OverridesList, overrideCounts } from "./overrides-review";
import { ReadingSheet, ZHistoryList } from "./reading-sheet";
import {
  dayNextStep,
  dayStatusWords,
  type DayDetail,
  type Movement,
  type OverrideRow,
  type PrintModel,
  type SessionRow,
  type TillDaySummary,
} from "./store-day-model";
import {
  ForceCloseForm,
  RegistersBoard,
  SessionsTable,
  TillDayDetailView,
  TillDaysList,
} from "./till-days";

const html = (node: React.ReactNode) => renderToStaticMarkup(node as never);

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: "6d0f1f2e-aaaa-4bbb-8ccc-000000000001",
  number: "SHF-REG01-261106-0001",
  cashier: "Ana Cruz",
  openedAt: Date.parse("2026-11-06T00:00:00Z"),
  closedAt: Date.parse("2026-11-06T08:00:00Z"),
  status: "closed",
  openingFloat: "200000",
  cashSales: "450000",
  floatIn: "0",
  paidIn: "0",
  drops: "500000",
  pickups: "0",
  paidOut: "0",
  expected: "150000",
  declared: "150000",
  variance: "0",
  forced: false,
  ...over,
});
const printModel = (over: Partial<PrintModel> = {}): PrintModel => ({
  title: "Z READING",
  docNumber: "Z-REG01-261106-0001",
  reprint: false,
  sample: true,
  lines: [
    { label: "Z counter no.", value: "1", strong: true },
    { label: "Gross sales", value: "₱9,000.00", strong: true },
    { label: "Senior citizen discount (20%)", value: "₱6.96" },
  ],
  footer: "NOT FILED - SAMPLE",
  ...over,
});
const detail = (
  over: Partial<DayDetail["day"]> = {},
  sessions = [session()],
): DayDetail => ({
  day: {
    id: "d1",
    registerId: "r1",
    businessDate: "2026-11-06",
    status: "open",
    number: "TILL-REG01-261106-0001",
    canZ: false,
    openSessions: 0,
    pendingReversals: 0,
    ...over,
  },
  reading: {
    register: "Till one",
    store: "Cebu Colon",
    sessions,
    sales: { netCentavos: "450000", transactions: 3 },
    cash: { expectedCentavos: "150000" },
  },
  printModel: printModel(),
  movements: [],
  overrides: [],
  xReads: [],
  z: null,
});
const movement = (over: Partial<Movement> = {}): Movement => ({
  id: "m1",
  shiftId: "s1",
  kind: "drop",
  label: "Cash drop",
  amountCentavos: "500000",
  effectCentavos: "-500000",
  reasonCode: "safe_drop",
  reasonLabel: "Move to the safe",
  note: null,
  supervisorName: "Store supervisor",
  slipNumber: "REM-REG01-261106-0001",
  recordedBy: "Ana Cruz",
  capturedAt: Date.parse("2026-11-06T03:00:00Z"),
  ...over,
});
const day = (over: Partial<TillDaySummary> = {}): TillDaySummary => ({
  id: "d1",
  registerId: "r1",
  registerName: "Till one",
  terminal: "REG01",
  storeName: "Cebu Colon",
  businessDate: "2026-11-06",
  status: "open",
  number: "TILL-REG01-261106-0001",
  sessions: 2,
  openSessions: 0,
  pendingReversals: 0,
  netSalesCentavos: "900000",
  zId: null,
  zNumber: null,
  zCounter: null,
  canZ: false,
  ...over,
});

describe("next step (queue first, one primary action)", () => {
  it("waits for open sessions, then pending voids, then offers the Z reading", () => {
    const open = dayNextStep(detail({ openSessions: 2 }));
    expect(open.action).toBe("none");
    expect(open.text).toContain("2 cashier sessions are still open");
    expect(dayNextStep(detail({ openSessions: 1 })).text).toContain(
      "1 cashier session is still open",
    );
    expect(dayNextStep(detail({ pendingReversals: 1 })).text).toContain(
      "needs a decision",
    );
    const ready = dayNextStep(detail());
    expect(ready).toMatchObject({ action: "z", actionLabel: "Run Z reading" });
    expect(dayNextStep(detail({ status: "z_done" })).action).toBe("none");
  });
  it("IP-INT2FIX: an old day closed without a Z is readable, says so, and offers no Z button", () => {
    const old = dayNextStep(detail({ status: "closed_no_z", openSessions: 0 }));
    expect(old.action).toBe("none");
    expect(old.text).toContain("before Z readings");
    expect(dayStatusWords("closed_no_z")).toBe(
      "Closed before Z readings started",
    );
  });
});

describe("till day detail", () => {
  it("shows the Z button only when every session is closed", () => {
    const blocked = html(
      createElement(TillDayDetailView, {
        detail: detail({ openSessions: 1, canZ: false }, [
          session({
            status: "open",
            closedAt: null,
            declared: null,
            variance: null,
          }),
        ]),
        onZ: vi.fn(),
      }),
    );
    expect(blocked).toContain("still open");
    expect(blocked).not.toContain("Run Z reading");
    const ready = html(
      createElement(TillDayDetailView, {
        detail: detail({ canZ: true }),
        onZ: vi.fn(),
        onStartClosing: vi.fn(),
      }),
    );
    expect(ready).toContain("Run Z reading");
    expect(ready).toContain("All cashier sessions are closed");
  });
  it("uses plain words, document numbers and pesos, never ids or centavos", () => {
    const view = html(
      createElement(TillDayDetailView, {
        detail: detail({ canZ: true }),
        onZ: vi.fn(),
      }),
    );
    expect(view).toContain("TILL-REG01-261106-0001");
    expect(view).toContain("SHF-REG01-261106-0001");
    expect(view).toContain("₱1,500.00");
    expect(view).not.toMatch(/6d0f1f2e/);
    expect(view.toLowerCase()).not.toContain("centavo");
    expect(view).not.toContain("blind declaration");
    expect(view).toContain("Cashier sessions");
  });
  it("a closed day shows the final Z with no action", () => {
    const view = html(
      createElement(TillDayDetailView, {
        detail: detail({ status: "z_done" }),
        onZ: vi.fn(),
      }),
    );
    expect(view).toContain("This day is closed");
    expect(view).not.toContain("Run Z reading");
  });
});

describe("sessions: expected, counted, variance", () => {
  it("shows over/short and keeps the blind count blind", () => {
    const view = html(
      createElement(SessionsTable, {
        sessions: [
          session({ variance: "-5000", declared: "145000" }),
          session({
            id: "x2",
            cashier: "Ben Reyes",
            expected: null,
            declared: null,
            variance: null,
            status: "closed",
          }),
        ],
      }),
    );
    expect(view).toContain("Hidden until you are counted");
    expect(view).toMatch(/[−-]₱50\.00/);
    expect(view).toContain("text-danger");
    const exact = html(createElement(SessionsTable, { sessions: [session()] }));
    expect(exact).toContain("Exact");
  });
  it("offers the office a force-close with a required reason on open sessions only", () => {
    const open = session({
      id: "o1",
      status: "open",
      closedAt: null,
      declared: null,
      variance: null,
    });
    const view = html(
      createElement(SessionsTable, {
        sessions: [open, session()],
        onForceClose: vi.fn(),
      }),
    );
    expect(view).toContain("Close from the office");
    expect(view.match(/Close from the office/g)).toHaveLength(1);
    const form = html(
      createElement(ForceCloseForm, { session: open, onSubmit: vi.fn() }),
    );
    expect(form).toContain("Why is the office closing it?");
    expect(form).toContain("disabled");
    const forced = html(
      createElement(SessionsTable, {
        sessions: [
          session({
            status: "force_closed",
            forced: true,
            declared: null,
            variance: null,
          }),
        ],
      }),
    );
    expect(forced).toContain("Closed by the office (not counted)");
  });
});

describe("cash movements", () => {
  it("lists a drop with its slip, supervisor and effect on the drawer", () => {
    const view = html(
      createElement(MovementsList, { movements: [movement()] }),
    );
    expect(view).toContain("Cash drop");
    expect(view).toContain("REM-REG01-261106-0001");
    expect(view).toContain("Store supervisor");
    expect(view).toMatch(/[−-]₱5,000\.00/);
    expect(html(createElement(MovementsList, { movements: [] }))).toContain(
      "No cash drops, pickups or paid-outs today.",
    );
  });
  it("the form needs an open session and one clear primary action", () => {
    expect(
      html(
        createElement(CashMovementForm, { sessions: [], onSubmit: vi.fn() }),
      ),
    ).toContain("need an open cashier session");
    const form = html(
      createElement(CashMovementForm, {
        sessions: [{ id: "s1", cashier: "Ana Cruz" }],
        onSubmit: vi.fn(),
      }),
    );
    expect(form).toContain(">Save<");
    expect(form).toContain("Move to the safe");
    expect(form).toContain("Amount (₱)");
  });
});

describe("supervisor approvals", () => {
  const rows: OverrideRow[] = [
    {
      id: "o1",
      registerId: "r1",
      registerName: "Till one",
      businessDate: "2026-11-06",
      kind: "void_sale",
      label: "Sale void",
      method: "pin_online",
      supervisorName: "Store supervisor",
      cashierName: "Ana Cruz",
      reason: "Customer left",
      amountCentavos: "450000",
      refType: "sale",
      refId: "s",
      capturedAt: Date.parse("2026-11-06T02:00:00Z"),
    },
    {
      id: "o2",
      registerId: "r1",
      registerName: "Till one",
      businessDate: "2026-11-06",
      kind: "cash_drop",
      label: "Cash drop",
      method: "pin_offline",
      supervisorName: "Store supervisor",
      cashierName: "Ana Cruz",
      reason: "Move to the safe",
      amountCentavos: "500000",
      refType: "cash_movement",
      refId: "m",
      capturedAt: Date.parse("2026-11-06T03:00:00Z"),
    },
    {
      id: "o3",
      registerId: "r1",
      registerName: "Till one",
      businessDate: "2026-11-06",
      kind: "cash_drop",
      label: "Cash drop",
      method: "office",
      supervisorName: "Office boss",
      cashierName: "Ben Reyes",
      reason: null,
      amountCentavos: null,
      refType: null,
      refId: null,
      capturedAt: Date.parse("2026-11-06T04:00:00Z"),
    },
  ];
  it("counts per kind for the filter chips and filters the list", () => {
    expect(overrideCounts(rows)).toEqual([
      ["cash_drop", 2],
      ["void_sale", 1],
    ]);
    const all = html(createElement(OverridesList, { rows }));
    expect(all).toContain("Sale void");
    expect(all).toContain("PIN at the till, offline");
    const drops = html(
      createElement(OverridesList, { rows, kind: "cash_drop" }),
    );
    expect(drops).not.toContain("Customer left");
    expect(html(createElement(OverridesList, { rows: [] }))).toContain(
      "No supervisor approvals",
    );
  });
});

describe("X and Z sheets", () => {
  it("renders the printed model and marks a reprint as a copy", () => {
    const original = html(createElement(ReadingSheet, { model: printModel() }));
    expect(original).toContain("Z READING");
    expect(original).toContain("NOT FILED - SAMPLE");
    expect(original).toContain("₱6.96");
    expect(original).not.toContain("Reprint");
    const copy = html(
      createElement(ReadingSheet, {
        model: printModel({ reprint: true }),
        onPrint: vi.fn(),
      }),
    );
    expect(copy).toContain("Reprint — copy of the original");
    expect(copy).toContain("Print copy");
  });
  it("history lists typed and older Z readings", () => {
    const view = html(
      createElement(ZHistoryList, {
        readings: [
          {
            id: "z2",
            readId: "r2",
            businessDate: "2026-11-07",
            zCounter: 2,
            netSalesCentavos: "450000",
            endingNetCentavos: "1350000",
          },
          {
            id: "z0",
            readId: "r0",
            businessDate: "2025-12-31",
            zCounter: 97,
            netSalesCentavos: "123400",
            legacy: true,
          },
        ],
        onOpen: vi.fn(),
      }),
    );
    expect(view).toContain("₱13,500.00");
    expect(view).toContain("Older record");
    expect(view.match(/View and print/g)).toHaveLength(1);
    expect(html(createElement(ZHistoryList, { readings: [] }))).toContain(
      "No Z readings",
    );
  });
});

describe("registers and the day queue", () => {
  it("puts days that are ready for the Z reading first", () => {
    const view = html(
      createElement(TillDaysList, {
        onOpen: vi.fn(),
        days: [
          day({
            id: "a",
            registerName: "Till A",
            businessDate: "2026-11-06",
            status: "z_done",
            zCounter: 1,
          }),
          day({ id: "b", registerName: "Till B", canZ: true }),
          day({ id: "c", registerName: "Till C", openSessions: 1 }),
        ],
      }),
    );
    expect(view.indexOf("Till B")).toBeLessThan(view.indexOf("Till C"));
    expect(view.indexOf("Till C")).toBeLessThan(view.indexOf("Till A"));
    expect(view).toContain("Run Z reading");
    expect(view).toContain("Day closed (Z done)");
  });
  it("shows one card per register with its latest day", () => {
    const view = html(
      createElement(RegistersBoard, {
        onOpen: vi.fn(),
        days: [
          day({ id: "old", businessDate: "2026-11-05", status: "z_done" }),
          day({ id: "new", businessDate: "2026-11-06", canZ: true }),
        ],
      }),
    );
    expect(view.match(/Till one/g)).toHaveLength(1);
    expect(view).toContain("Nov 6, 2026");
    expect(view).toContain("Ready for Z reading");
    expect(view).toContain("₱9,000.00");
  });
});
