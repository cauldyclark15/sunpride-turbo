import type { Metadata } from "next";
import { CockpitRoute } from "@/components/cockpit/cockpit-route";
import { StoresPage } from "@/components/cockpit/pages/stores";

export const metadata: Metadata = { title: "Customers" };

export default function Page() {
  return (
    <CockpitRoute slug="stores">
      <StoresPage />
    </CockpitRoute>
  );
}
