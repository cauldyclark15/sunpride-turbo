import { describe, expect, it } from "vitest";
import {
  daysToExpiry,
  nextStep,
  receivePayload,
  receiveProblems,
  receiveRows,
  rowExtra,
  rowMissing,
  varianceText,
  type Transfer,
} from "./transfer-model";
import { line } from "./transfer-fixtures";

describe("transfer model", () => {
  it("gives each state one next step", () => {
    expect(nextStep("requested")?.command).toBe("approve");
    expect(nextStep("approved")?.command).toBe("pick");
    expect(nextStep("picking")?.command).toBe("dispatch");
    expect(nextStep("dispatched")?.command).toBe("receive");
    expect(nextStep("partially_received")?.command).toBe("receive");
    expect(nextStep("review_needed")?.command).toBe("resolve-variance");
    expect(nextStep("closed")).toBeNull();
  });

  it("pre-fills everything as arrived, in cases and pieces", () => {
    const rows = receiveRows({ lines: [line()] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.good).toEqual({ cases: 10, pieces: 0 });
    expect(rowMissing(rows[0]!)).toBe(0);
  });

  it("lists only batches that still have stock to arrive", () => {
    const done = line({
      allocations: [
        { ...line().allocations[0]!, remainingBase: 0, receivedGoodBase: 480 },
      ],
    });
    expect(receiveRows({ lines: [done] })).toEqual([]);
  });

  it("shows short and extra from what the receiver types", () => {
    const [row] = receiveRows({ lines: [line()] });
    const short = { ...row!, good: { cases: 9, pieces: 0 } };
    expect(rowMissing(short)).toBe(48);
    const extra = { ...row!, good: { cases: 10, pieces: 6 } };
    expect(rowExtra(extra)).toBe(6);
  });

  it("asks for a reason and a photo when something is damaged", () => {
    const [row] = receiveRows({ lines: [line()] });
    const damaged = {
      ...row!,
      good: { cases: 9, pieces: 0 },
      damaged: { cases: 1, pieces: 0 },
    };
    expect(receiveProblems([damaged])).toEqual([
      "Longganisa 500 g: choose why some are damaged.",
    ]);
    expect(
      receiveProblems([
        { ...damaged, reason: "DMG-TRANSIT", reasonNeedsPhoto: true },
      ]),
    ).toEqual(["Longganisa 500 g: take a photo of the damaged items."]);
    expect(
      receiveProblems([
        {
          ...damaged,
          reason: "DMG-TRANSIT",
          reasonNeedsPhoto: true,
          photoCount: 1,
        },
      ]),
    ).toEqual([]);
  });

  it("builds the receive body per batch, base pieces on the wire", () => {
    const [row] = receiveRows({ lines: [line()] });
    const body = receivePayload(
      "t1",
      [
        {
          ...row!,
          good: { cases: 9, pieces: 0 },
          damaged: { cases: 1, pieces: 0 },
          reason: "DMG-TRANSIT",
          photoCount: 1,
        },
      ],
      false,
    );
    expect(body).toEqual({
      transferId: "t1",
      final: false,
      lines: [
        {
          lineId: "l1",
          batchId: "b1",
          receivedGoodBase: 432,
          receivedDamagedBase: 48,
          reasonCode: "DMG-TRANSIT",
          photoCount: 1,
        },
      ],
    });
  });

  it("words the open differences", () => {
    const t = {
      lines: [line({ shortBase: 96, receivedDamagedBase: 48, overBase: 6 })],
    } as Pick<Transfer, "lines">;
    expect(varianceText(t)).toBe(
      "Longganisa 500 g: short 2 cs · Longganisa 500 g: damaged 1 cs · Longganisa 500 g: over 6 pc",
    );
  });

  it("counts days to expiry", () => {
    expect(daysToExpiry(null)).toBeNull();
    expect(daysToExpiry(Date.UTC(2027, 0, 11), Date.UTC(2027, 0, 1))).toBe(10);
  });
});
