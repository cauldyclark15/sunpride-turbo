import type { Metadata } from "next";
import { IssueCreatePage } from "@/components/issues/issue-create-page";
export const metadata: Metadata = { title: "New issue" };
export default function IssuePage() {
  return <IssueCreatePage />;
}
