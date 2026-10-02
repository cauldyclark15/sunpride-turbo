import type { Metadata } from "next";
import { IssueDetailPage } from "@/components/issues/issue-detail-page";
export const metadata: Metadata = { title: "Issue" };
export default async function IssuePage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  const { number } = await params;
  return <IssueDetailPage number={number} />;
}
