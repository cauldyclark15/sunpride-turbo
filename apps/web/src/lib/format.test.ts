import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatDay,
  formatMonth,
  formatPeriod,
  formatStatus,
  formatTime,
  manilaDay,
} from "./format";

// 2026-11-12 10:27:33Z = Nov 12, 2026 6:27:33 PM in Manila.
const AT = Date.parse("2026-11-12T10:27:33Z");

describe("formatDate", () => {
  it("reads a Manila date-only value as that day, in words", () => {
    expect(formatDate("2026-11-12")).toBe("Nov 12, 2026");
    expect(formatDate("2026-09-28")).toBe("Sep 28, 2026");
  });
  it("shows instants on their Manila day (not the UTC day)", () => {
    // 2026-11-11T17:00Z is already Nov 12 in Manila.
    expect(formatDate("2026-11-11T17:00:00Z")).toBe("Nov 12, 2026");
    expect(formatDate(AT)).toBe("Nov 12, 2026");
    expect(formatDate(new Date(AT))).toBe("Nov 12, 2026");
    expect(formatDate(String(AT))).toBe("Nov 12, 2026");
  });
  it("renders empty as a dash and leaves junk visible", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("not a date")).toBe("not a date");
  });
});

describe("formatDateTime / formatTime", () => {
  it("is words plus a 12-hour Manila clock, never 11/12/2026", () => {
    expect(formatDateTime(AT)).toBe("Nov 12, 2026, 6:27 PM");
    expect(formatDateTime("2026-11-12T10:27:33.000Z")).toBe(
      "Nov 12, 2026, 6:27 PM",
    );
    expect(formatDateTime(AT)).not.toMatch(/\d+\/\d+\/\d{4}/);
    expect(formatTime(AT)).toBe("6:27 PM");
  });
  it("shows just the day for a date-only value", () => {
    expect(formatDateTime("2026-11-12")).toBe("Nov 12, 2026");
  });
});

describe("formatPeriod", () => {
  it("collapses the year inside one year (WEB-142 / WEB-166)", () => {
    expect(formatPeriod("2026-10-29", "2026-11-12")).toBe(
      "Oct 29 – Nov 12, 2026",
    );
    expect(formatPeriod("2026-11-06", "2026-11-12")).toBe(
      "Nov 6 – Nov 12, 2026",
    );
  });
  it("keeps both years across a year end and collapses one day", () => {
    expect(formatPeriod("2026-12-29", "2027-01-04")).toBe(
      "Dec 29, 2026 – Jan 4, 2027",
    );
    expect(formatPeriod("2026-11-12", "2026-11-12")).toBe("Nov 12, 2026");
  });
  it("reads open ends", () => {
    expect(formatPeriod("2026-11-12", null)).toBe("From Nov 12, 2026");
    expect(formatPeriod(null, "2026-11-12")).toBe("Until Nov 12, 2026");
    expect(formatPeriod(null, null)).toBe("—");
  });
});

describe("formatMonth / formatDay / manilaDay", () => {
  it("writes a month in words (WEB-037)", () => {
    expect(formatMonth("2026-12")).toBe("December 2026");
    expect(formatMonth("2026-12-01")).toBe("December 2026");
  });
  it("drops the year only within the current Manila year", () => {
    const now = Date.parse("2026-11-12T00:00:00+08:00");
    expect(formatDay("2026-11-09", now)).toBe("Nov 9");
    expect(formatDay("2025-11-09", now)).toBe("Nov 9, 2025");
  });
  it("gives the Manila calendar day for comparisons", () => {
    expect(manilaDay("2026-11-11T17:00:00Z")).toBe("2026-11-12");
    expect(manilaDay(null)).toBeNull();
  });
});

describe("formatStatus", () => {
  it("turns stored enum words into sentence case (WEB-142)", () => {
    expect(formatStatus("needs_evidence")).toBe("Needs evidence");
    expect(formatStatus("needs evidence")).toBe("Needs evidence");
    expect(formatStatus("rejected")).toBe("Rejected");
    expect(formatStatus("in-transit")).toBe("In transit");
    expect(formatStatus("NEEDS_EVIDENCE")).toBe("Needs evidence");
    expect(formatStatus("SAP")).toBe("SAP");
  });
  it("uses supplied wording first and dashes empty values", () => {
    expect(formatStatus("sap_ack", { sap_ack: "Waiting for SAP" })).toBe(
      "Waiting for SAP",
    );
    expect(formatStatus(null)).toBe("—");
    expect(formatStatus("")).toBe("—");
  });
});
