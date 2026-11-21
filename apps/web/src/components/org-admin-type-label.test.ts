import { describe, expect, it } from "vitest";
import { typeLabel } from "./org-admin";

describe("organization level labels (SP-0217)", () => {
  it("never shows a lowercase level", () => {
    expect(typeLabel("territory")).toBe("Territory");
    expect(
      typeLabel("TERRITORY", [{ code: "TERRITORY", label: "territory" }]),
    ).toBe("Territory");
    expect(typeLabel("zone", [{ code: "zone", label: "sales zone" }])).toBe(
      "Sales zone",
    );
    expect(typeLabel("sub_area")).toBe("Sub area");
  });
  it("keeps the office words", () => {
    expect(typeLabel("national")).toBe("Company");
    expect(typeLabel("region")).toBe("Region");
    expect(typeLabel("area")).toBe("Branch");
  });
});
