import type { Metadata } from "next";
import { CockpitRoute } from "@/components/cockpit/cockpit-route";
import { TodayPage } from "@/components/cockpit/pages/today";
import { InstallCard } from "@/components/pwa/install-card";

export const metadata: Metadata = { title: "Today" };

export default function Page() {
  return (
    <CockpitRoute slug="today">
      <InstallCard />
      <TodayPage />
    </CockpitRoute>
  );
}
