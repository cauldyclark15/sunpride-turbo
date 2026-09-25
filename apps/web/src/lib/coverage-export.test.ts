import { describe, expect, it, vi } from "vitest";
import {
  collectSchedule,
  scheduleCsv,
  type ScheduleHeader,
  type ScheduleRow,
} from "./coverage-export";
const header: ScheduleHeader = {
  planId: "plan",
  localMonth: "2026-09",
  version: 2,
  status: "active",
  assigneeName: "Seller",
  preparedByName: "Manager",
  preparedAt: 1,
  approvedByName: "Approver",
  approvedAt: 2,
  signedHashPrefix: "abcdef012345",
};
const row: ScheduleRow = {
  slotKey: "s",
  serviceDate: "2026-09-28",
  kind: "outlet_visit",
  outletCode: "+X",
  name: '=SUM(1,2)\n"quoted"',
  sequence: 1,
  visitStatus: "planned",
  durationMinutes: 20,
};
describe("coverage export", () => {
  it("quotes RFC-4180, BOM, filter header, and guards formula cells", () => {
    const csv = scheduleCsv(header, [row], { routeId: "-ROUTE" });
    expect(csv.startsWith("\uFEFFPlan,plan")).toBe(true);
    expect(csv).toContain("'-ROUTE");
    expect(csv).toContain("'+X");
    expect(csv).toContain('"\'=SUM(1,2)\n""quoted"""');
    expect(csv).toContain("Signed hash prefix,abcdef012345");
    expect(
      scheduleCsv(
        { ...header, status: "UNAPPROVED", signedHashPrefix: undefined },
        [],
        {},
      ),
    ).toContain("UNAPPROVED");
  });
  it("collects empty/large pages completely and aborts a failed second page", async () => {
    const fetch = vi.fn(async (cursor: string | null) =>
      cursor === null
        ? {
            planHeader: header,
            page: Array(20).fill(row),
            continueCursor: "20",
            isDone: false,
          }
        : {
            planHeader: header,
            page: [row],
            continueCursor: "21",
            isDone: true,
          },
    );
    expect((await collectSchedule(fetch)).rows).toHaveLength(21);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      (
        await collectSchedule(async () => ({
          planHeader: header,
          page: [],
          continueCursor: "0",
          isDone: true,
        }))
      ).rows,
    ).toEqual([]);
    await expect(
      collectSchedule(async (cursor) => {
        if (cursor) throw new Error("network failed");
        return {
          planHeader: header,
          page: [row],
          continueCursor: "1",
          isDone: false,
        };
      }),
    ).rejects.toThrow("network failed");
    await expect(
      collectSchedule(async (cursor) => ({
        planHeader: header,
        page: [row],
        continueCursor: cursor ?? "1",
        isDone: false,
      })),
    ).rejects.toThrow("cursor did not advance");
    await expect(
      collectSchedule(async (cursor) => ({
        planHeader: header,
        page: Array(20).fill(row),
        continueCursor: String(Number(cursor ?? 0) + 20),
        isDone: false,
      })),
    ).rejects.toThrow("exceeds 500 rows");
  });
});
