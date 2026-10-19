import type { Metadata } from "next";
import { CockpitRoute } from "@/components/cockpit/cockpit-route";
import { SalesPage } from "@/components/cockpit/pages/sales";

export const metadata: Metadata = { title: "Sales & targets" };

export default function Page() {
  return (
    <CockpitRoute slug="sales">
      <SalesPage />
    </CockpitRoute>
  );
}
