import type { Metadata } from "next";
import { CockpitRoute } from "@/components/cockpit/cockpit-route";
import { TodayPage } from "@/components/cockpit/pages/today";

export const metadata: Metadata = { title: "Today" };

export default function Page() {
  return (
    <CockpitRoute slug="today">
      <TodayPage />
    </CockpitRoute>
  );
}
