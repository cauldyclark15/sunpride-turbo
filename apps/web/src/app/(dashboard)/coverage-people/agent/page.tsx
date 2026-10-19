import type { Metadata } from "next";
import { CockpitRoute } from "@/components/cockpit/cockpit-route";
import { AgentDayPage } from "@/components/cockpit/pages/coverage";

export const metadata: Metadata = { title: "A person's day" };

export default function Page() {
  return (
    <CockpitRoute slug="coverage-people">
      <AgentDayPage />
    </CockpitRoute>
  );
}
