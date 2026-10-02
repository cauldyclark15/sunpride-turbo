import type { Metadata } from "next";
import { IssuesPage } from "@/components/issues/issues-page";
export const metadata: Metadata = { title: "Issues" };
export default function IssuePage() {
  return <IssuesPage />;
}
