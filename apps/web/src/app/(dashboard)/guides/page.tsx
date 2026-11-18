import type { Metadata } from "next";
import { GuidesPage } from "@/components/guides/guides-page";

export const metadata: Metadata = { title: "Guides" };

/** SP-0201: every how-to and PDF guide, for every signed-in role. The files themselves are public. */
export default function Guides() {
  return <GuidesPage />;
}
