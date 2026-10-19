import type { Metadata } from "next";
import { CockpitRoute } from "@/components/cockpit/cockpit-route";
import { StorePage } from "@/components/cockpit/pages/stores";

export const metadata: Metadata = { title: "Store" };

export default function Page() {
  return (
    <CockpitRoute slug="stores">
      <StorePage />
    </CockpitRoute>
  );
}
