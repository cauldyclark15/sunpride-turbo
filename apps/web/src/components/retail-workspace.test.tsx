import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/api", () => ({
  apiFetch: vi.fn(),
  mutate: vi.fn(),
  useApi: () => ({ data: undefined }),
  useLive: vi.fn(),
}));
vi.mock("../lib/auth/session", () => ({
  useSession: () => ({ profile: { active: true, role: "viewer" } }),
}));
import {
  BatchTrace,
  monday,
  PerfectStoreScore,
  type WeekScore,
} from "./retail-workspace";
const week: WeekScore = {
  accountName: "Sample frozen account",
  weekStart: "2026-10-12",
  score: null,
  status: "incomplete",
  completeBranches: 0,
  totalBranches: 1,
  branches: [
    {
      outletId: "private-outlet-uuid",
      outletName: "Sample Cebu branch",
      score: null,
      target: 90,
      missing: ["availability", "promotion"],
      components: [
        {
          key: "freezer",
          weight: 20,
          status: "complete",
          value: { score: 50 },
        },
      ],
    },
  ],
};
describe("F-316 weekly perfect store evidence", () => {
  it("keeps incomplete separate from zero and exposes the next missing evidence", () => {
    const html = renderToStaticMarkup(
      <PerfectStoreScore
        current={week}
        prior={{ ...week, score: 75, status: "complete" }}
      />,
    );
    expect(html).toContain("Incomplete");
    expect(html).toContain("90%");
    expect(html).toContain("75.0%");
    expect(html).toContain("Availability, Promotion");
    expect(html).toContain("Sample Cebu branch");
    expect(html).not.toContain("private-outlet-uuid");
  });
  it("shows the same complete account score, prior period and branch explanation", () => {
    const current = {
      ...week,
      status: "complete",
      score: 85,
      completeBranches: 1,
      branches: [{ ...week.branches[0]!, score: 85, missing: [] }],
    };
    const html = renderToStaticMarkup(
      <PerfectStoreScore current={current} prior={{ ...week, score: 80 }} />,
    );
    expect(html).toContain("85.0%");
    expect(html).toContain("+5.0");
    expect(html).toContain("weight 20%");
    expect(html).toContain("50.0%");
  });
  it("selects the previous completed Monday in Manila across Sunday UTC", () => {
    expect(monday(Date.parse("2026-10-18T17:00:00Z"))).toBe("2026-10-12");
  });
});
describe("F-614 batch trace", () => {
  it("labels inferred van allocations without claiming a confirmed physical batch", () => {
    const html = renderToStaticMarkup(
      <BatchTrace
        trace={{
          lot: { batch: "SAMPLE-BATCH-X", product: "Sample frozen product" },
          affectedOutlets: 2,
          warning: "Uncaptured delivery batches remain unknown.",
          rows: [
            {
              id: "private-row-id",
              outlet_name: "Cebu branch",
              quantity_base: 24,
              lot_number: "SAMPLE-BATCH-X",
              certainty: "allocation_inference",
              source_key: "private-source",
            },
            {
              id: "private-row-id-2",
              outlet_name: "Mandaue branch",
              quantity_base: 12,
              lot_number: "SAMPLE-BATCH-X",
              certainty: "sample_confirmation",
              source_key: "private-source-2",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("2 affected outlets");
    expect(html).toContain("physical batch not confirmed");
    expect(html).toContain("Sample confirmed receipt");
    expect(html).not.toContain("private-row-id");
    expect(html).not.toContain("private-source");
  });
});
