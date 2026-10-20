import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canAccessWebModule } from "../../lib/module-access";
import { getWebNavigation } from "../../config/navigation";
import { ProgrammeView, type ProgrammeOverview } from "./programme-workspace";

const counts = {
  built: 1,
  partly_built: 1,
  changing_to_spec: 0,
  not_built: 0,
  needs_sunpride: 1,
  conditional: 0,
};
const labels = {
  built: "Built",
  partly_built: "Partly built",
  changing_to_spec: "Being changed to match your spec",
  not_built: "Not built yet",
  needs_sunpride: "Needs Sunpride",
  conditional: "Conditional",
};
const data: ProgrammeOverview = {
  loaded: true,
  featureCount: 3,
  totals: counts,
  statusLabels: labels,
  waves: [
    {
      code: "W0",
      name: "Foundation and Master Data",
      months: "Month 1 to 3",
      goNoGoOwner: "CIO and VP Sales",
      exitCriteria: [
        "SAP interface catalogue signed and round-trip tested in QA",
      ],
      counts,
      featureCount: 3,
      mustCount: 3,
      blocks: [
        {
          id: "BB-01",
          name: "Integration and Sync Backbone",
          features: [
            {
              id: "F-001",
              name: "SAP interface catalogue and contract",
              description: "Enumerate every interface.",
              priority: "Must",
              status: "partly_built",
              statusLabel: "Partly built",
              now: "A draft list of SAP links.",
              next: "Write the full SAP interface list.",
              laneWhen: "Wave A, started 20 Oct (SAP link)",
              deferralPool: false,
            },
          ],
        },
      ],
    },
  ],
};

describe("F-025 programme page", () => {
  it("F-025 shows waves, the go/no-go owner, exit criteria and plain status", () => {
    const html = renderToStaticMarkup(<ProgrammeView data={data} />);
    expect(html).toContain("3 features in Sunpride");
    expect(html).toContain("Go/no-go: CIO and VP Sales");
    expect(html).toContain("SAP interface catalogue signed");
    expect(html).toContain("Partly built");
    expect(html).toContain("Wave A, started 20 Oct (SAP link)");
    expect(html).toContain("1 feature waits on Sunpride");
    expect(html).not.toContain("partly_built");
  });

  it("F-025 an unloaded list reads as needing setup, not as zero", () => {
    const html = renderToStaticMarkup(
      <ProgrammeView data={{ ...data, loaded: false, featureCount: 0 }} />,
    );
    expect(html).toContain("Needs setup");
    expect(html).not.toContain("0 features");
  });

  it("F-025 only administrators and the owner see Setup → Programme", () => {
    for (const role of ["super_admin", "admin"]) {
      expect(canAccessWebModule("programme", role)).toBe(true);
      const nav = getWebNavigation("/programme", (slug) =>
        canAccessWebModule(slug, role),
      );
      expect(nav.activePrimaryId).toBe("setup");
      expect(nav.moduleTabs.map((t) => t.id)).toContain("programme");
    }
    for (const role of ["manager", "operations", "analyst", "viewer", "sales"])
      expect(canAccessWebModule("programme", role)).toBe(false);
  });
});
