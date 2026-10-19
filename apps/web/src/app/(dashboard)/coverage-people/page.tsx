import type { Metadata } from "next";
import { CockpitRoute } from "@/components/cockpit/cockpit-route";
import { CoveragePage } from "@/components/cockpit/pages/coverage";

export const metadata: Metadata = { title: "Coverage & people" };

export default function Page() {
  return (
    <CockpitRoute slug="coverage-people">
      <CoveragePage />
    </CockpitRoute>
  );
}
