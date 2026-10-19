import type { Metadata } from "next";
import { CockpitRoute } from "@/components/cockpit/cockpit-route";
import { MoneyPage } from "@/components/cockpit/pages/money";

export const metadata: Metadata = { title: "Money" };

export default function Page() {
  return (
    <CockpitRoute slug="money">
      <MoneyPage />
    </CockpitRoute>
  );
}
