import { describe, expect, it } from "vitest";
import { carriedLine } from "./joint-call-actions";

describe("F-223 joint call follow-up", () => {
  const a = {
    id: "a",
    agreedOn: "2026-10-19",
    agreement: "Face the top 5 SKUs",
    owner: "trainee" as const,
    dueOn: "2026-10-20",
    status: "open" as const,
    reviewNote: null,
  };
  it("F-223 marks an unreviewed agreement overdue after its due day", () => {
    expect(carriedLine(a, "2026-10-21")).toBe(
      "Face the top 5 SKUs — trainee to do by Oct 20, 2026 (overdue); agreed Oct 19, 2026",
    );
    expect(carriedLine(a, "2026-10-20")).not.toContain("overdue");
  });
  it("F-223 a reviewed agreement is never called overdue", () => {
    expect(carriedLine({ ...a, status: "done" }, "2026-10-30")).not.toContain(
      "overdue",
    );
  });
});
