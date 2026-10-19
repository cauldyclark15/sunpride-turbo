import type { Metadata } from "next";
import { CockpitRoute } from "@/components/cockpit/cockpit-route";
import { DecidePage } from "@/components/cockpit/pages/decide";

export const metadata: Metadata = { title: "Decide" };

export default function Page() {
  return (
    <CockpitRoute slug="decide">
      <DecidePage />
    </CockpitRoute>
  );
}
