import { describe, expect, it } from "vitest";
import { OPERATIONS_SECTIONS, operationsSectionFor } from "@/config/navigation";
import { subRowFor } from "./operations-workspace";

const section = (id: string) => OPERATIONS_SECTIONS.find((s) => s.id === id)!;

describe("WEB-026 the second row follows one rule on list and detail pages", () => {
  it("a multi-screen verb keeps the parent screen lit on its detail page", () => {
    const row = subRowFor(section("counts"), "/operations/counts/review/abc", "admin");
    expect(row?.current?.id).toBe("review");
    expect(subRowFor(section("counts"), "/operations/counts/plan", "admin")?.current?.id).toBe("plan");
  });
  it("a one-screen verb (Transfers) has no second row on the list, so none on the detail", () => {
    const transfers = operationsSectionFor("/operations/transfers/65cf418d")!;
    expect(transfers.id).toBe("transfers");
    expect(subRowFor(transfers, "/operations/transfers", "admin")).toBeNull();
    expect(subRowFor(transfers, "/operations/transfers/65cf418d", "admin")).toBeNull();
  });
});
