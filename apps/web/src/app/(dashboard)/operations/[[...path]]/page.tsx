import type { Metadata } from "next";
import { OperationsWorkspace } from "@/components/ops/operations-workspace";

export const metadata: Metadata = { title: "Operations" };

export default async function OperationsPage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path } = await params;
  return <OperationsWorkspace path={path ?? []} />;
}
