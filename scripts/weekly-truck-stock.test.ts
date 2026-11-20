import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  parseWeek,
  reconciliation,
  renderWorksheets,
  scaled,
  type StockWeek,
} from "./weekly-truck-stock";

// Invented values for arithmetic proof only. Not client data or a live workflow.
function fixture(): StockWeek {
  return {
    reference: "SAMPLE-REQUEST",
    approvedPlanReference: "SAMPLE-PLAN",
    weekStart: "2026-11-23",
    salesman: "Sample salesman",
    truck: "Sample truck",
    issuingDepot: "Sample depot",
    sapOrderReference: "SAMPLE-SO",
    lines: [
      {
        productCode: "SAMPLE-001",
        productName: "Sample product",
        uom: "PC",
        decimalPlaces: 0,
        requestedBase: 100,
        servedBase: 80,
        posSoldBase: 50,
        countedBase: 30,
        referenceUnitPriceMinor: 2500,
        posNetSalesMinor: 125000,
        batch: "",
        expiry: "",
        reason: "For discussion only",
      },
    ],
  };
}

describe("SP-0227 preparation worksheets", () => {
  test("keeps both partial-loading cashier alternatives distinct without selecting one", () => {
    const week = parseWeek(fixture());
    expect(reconciliation(week.lines[0]!)).toEqual({
      shortServed: 20n,
      requestedBasis: 70n,
      servedBasis: 50n,
      posDifference: 0n,
      requestedAmount: 175000n,
      servedAmount: 125000n,
    });
    const html = renderWorksheets(week);
    expect(html).toContain("NOT PAYABLE");
    expect(html).toContain("PHP 1750.00");
    expect(html).toContain("PHP 1250.00");
    expect(html).toContain("basis not confirmed");
  });
  test("no partial loading gives equal comparison quantities", () => {
    const l = fixture().lines[0]!;
    l.servedBase = 100;
    expect(reconciliation(l).requestedBasis).toBe(
      reconciliation(l).servedBasis,
    );
  });
  test("missing served, counted, price and POS quantities are unknown, not zero", () => {
    const l = fixture().lines[0]!;
    l.servedBase = null;
    l.countedBase = null;
    l.posSoldBase = null;
    l.referenceUnitPriceMinor = null;
    l.posNetSalesMinor = null;
    const week = fixture();
    week.lines = [l];
    expect(parseWeek(week).lines[0]!.countedBase).toBeNull();
    expect(reconciliation(l)).toEqual({
      shortServed: null,
      requestedBasis: null,
      servedBasis: null,
      posDifference: null,
      requestedAmount: null,
      servedAmount: null,
    });
    expect(renderWorksheets(week)).toContain("Not recorded");
    expect(renderWorksheets(week)).toContain("Not determined");
  });
  test("a recorded zero count and zero served are real values", () => {
    const l = fixture().lines[0]!;
    l.servedBase = 0;
    l.countedBase = 0;
    l.posSoldBase = 0;
    expect(reconciliation(l).servedBasis).toBe(0n);
    expect(reconciliation(l).servedAmount).toBe(0n);
    expect(reconciliation(l).posDifference).toBe(0n);
  });
  test("shows discrepancies with their sign, never clamps overages", () => {
    const l = fixture().lines[0]!;
    l.countedBase = 90;
    const r = reconciliation(l);
    expect(r.servedBasis).toBe(-10n);
    expect(r.servedAmount).toBeNull();
    expect(r.posDifference).toBe(-60n);
    expect(scaled(r.posDifference, 0)).toBe("−60");
  });
  test("additional service is visible instead of silently treated as a shortfall", () => {
    const l = fixture().lines[0]!;
    l.servedBase = 120;
    expect(reconciliation(l).shortServed).toBe(-20n);
  });
  test("decimal units use exact integer arithmetic, without guessing centavo rounding", () => {
    const l = fixture().lines[0]!;
    l.decimalPlaces = 3;
    l.requestedBase = 1500;
    l.servedBase = 1250;
    l.countedBase = 250;
    l.posSoldBase = 1000;
    expect(reconciliation(l).servedAmount).toBe(2500n);
    expect(scaled(1250n, 3)).toBe("1.250");
    l.referenceUnitPriceMinor = 1;
    l.countedBase = 0;
    expect(reconciliation(l).servedAmount).toBeNull();
  });
  test("large products and prices do not lose integer precision", () => {
    const l = fixture().lines[0]!;
    l.servedBase = Number.MAX_SAFE_INTEGER;
    l.countedBase = 0;
    l.referenceUnitPriceMinor = Number.MAX_SAFE_INTEGER;
    expect(reconciliation(l).servedAmount).toBe(
      BigInt(Number.MAX_SAFE_INTEGER) ** 2n,
    );
  });
  for (const bad of [
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "80",
    undefined,
  ]) {
    test(`refuses invalid served quantity: ${String(bad)}`, () => {
      const week: any = fixture();
      week.lines[0].servedBase = bad;
      expect(() => parseWeek(week)).toThrow();
    });
  }
  for (const date of [
    "2026-11-24",
    "2026-02-30",
    "2026-13-01",
    "2026-1-5",
    "not-a-date",
  ]) {
    test(`refuses invalid/non-Monday date: ${date}`, () => {
      const week = fixture();
      week.weekStart = date;
      expect(() => parseWeek(week)).toThrow();
    });
  }
  test("requires an explicit approved plan reference, without pretending to verify it", () => {
    const week = fixture();
    week.approvedPlanReference = "";
    expect(() => parseWeek(week)).toThrow("approved plan reference");
    expect(renderWorksheets(fixture())).toContain(
      "not proof that the plan has been approved",
    );
  });
  test("refuses duplicate rows and inconsistent scale or price across batches", () => {
    const week = fixture();
    week.lines.push({ ...week.lines[0]! });
    expect(() => parseWeek(week)).toThrow("duplicate");
    week.lines[1]!.batch = "SAMPLE-BATCH";
    expect(parseWeek(week).lines).toHaveLength(2);
    week.lines[1]!.decimalPlaces = 2;
    expect(() => parseWeek(week)).toThrow("same scale");
    week.lines[1]!.decimalPlaces = 0;
    week.lines[1]!.referenceUnitPriceMinor = 1;
    expect(() => parseWeek(week)).toThrow("same scale");
  });
  test("bounds the print pack and requires lines", () => {
    const week = fixture();
    week.lines = [];
    expect(() => parseWeek(week)).toThrow("1 to 40");
    week.lines = Array.from({ length: 41 }, () => fixture().lines[0]!);
    expect(() => parseWeek(week)).toThrow("1 to 40");
  });
  test("all four worksheets use the same request, issuing depot and unit", () => {
    const html = renderWorksheets(parseWeek(fixture()));
    expect(html.match(/<section class=sheet>/g)).toHaveLength(4);
    expect(html.match(/SAMPLE-REQUEST/g)).toHaveLength(4);
    expect(html.match(/Sample depot/g)).toHaveLength(5);
    expect(html.match(/<td>PC<\/td>/g)).toHaveLength(4);
    expect(html).toContain("NOT A STOCK POSTING OR CASH SETTLEMENT");
    expect(html).toContain("same issuing depot / plant");
    expect(html).toContain("next week uses a new stock request");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/(?:src|href)\s*=/i);
  });
  test("escapes names and reason text so it cannot inject active content", () => {
    const week = fixture();
    week.salesman = '<script>alert("x")</script>';
    week.lines[0]!.reason = '<img src=x onerror="alert(1)">';
    const html = renderWorksheets(parseWeek(week));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });
  test("blank worksheets contain no invented products, quantities or client policies", () => {
    const html = renderWorksheets(null);
    expect(html.match(/<section class=sheet>/g)).toHaveLength(4);
    expect(html).not.toContain("SAMPLE-");
    expect(html).not.toContain("PHP 0.00");
    expect(html).toContain("no reason list has been approved");
  });
  test("CLI generates both blank and supplied-data HTML without modifying input", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR!, "sp227-print-"));
    try {
      const input = join(dir, "input.json");
      const output = join(dir, "print.html");
      const source = JSON.stringify(fixture());
      await Bun.write(input, source);
      for (const args of [
        ["--output", output],
        ["--input", input, "--output", output],
      ]) {
        const proc = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "weekly-truck-stock.ts"),
            ...args,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        expect(await proc.exited).toBe(0);
        expect(await Bun.file(output).text()).toContain("Weekly stock request");
      }
      expect(await Bun.file(input).text()).toBe(source);
      const proc = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "weekly-truck-stock.ts"),
          "--input",
          input,
          "--output",
          input,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await proc.exited).not.toBe(0);
      expect(await Bun.file(input).text()).toBe(source);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
