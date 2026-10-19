import type { Metadata } from "next";
import { CockpitRoute } from "@/components/cockpit/cockpit-route";
import { VansPage } from "@/components/cockpit/pages/vans";

export const metadata: Metadata = { title: "Vans & cash" };

export default function Page() {
  return (
    <CockpitRoute slug="vans">
      <VansPage />
    </CockpitRoute>
  );
}
