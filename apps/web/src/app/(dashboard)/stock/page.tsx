import type { Metadata } from "next";
import { CockpitRoute } from "@/components/cockpit/cockpit-route";
import { StockPage } from "@/components/cockpit/pages/stock";

export const metadata: Metadata = { title: "Products & stock" };

export default function Page() {
  return (
    <CockpitRoute slug="stock">
      <StockPage />
    </CockpitRoute>
  );
}
