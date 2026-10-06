import type { Metadata } from "next";
import { IssueCreatePage } from "@/components/issues/issue-create-page";
export const metadata: Metadata = { title: "New issue" };
export default async function IssuePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { from } = await searchParams;
  return <IssueCreatePage from={typeof from === "string" ? from : undefined} />;
}
