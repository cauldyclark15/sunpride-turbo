import { describe, expect, it } from "vitest";
import { creditExposureLines } from "./model";

describe("WEB-102 credit exposure on the order drawer", () => {
  it("adds a pending order to the open balance so exposure is never below the order", () => {
    const text = creditExposureLines({
      status: "pending_approval",
      totalCentavos: 87_494_400,
      credit: { limit: 25_000_000, exposure: 7_875_167 },
    }).join(" · ");
    expect(text).toContain("Open balance ₱78,751.67");
    expect(text).toContain("Exposure including this order ₱953,695.67");
  });
  it("does not add a booked order twice", () => {
    expect(
      creditExposureLines({
        status: "posted",
        totalCentavos: 100,
        credit: { limit: 1000, exposure: 500 },
      }),
    ).toEqual(["Limit ₱10.00", "Exposure ₱5.00"]);
  });
});
