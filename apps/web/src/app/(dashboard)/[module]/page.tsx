import type { Metadata } from "next";
import { ModuleWorkspace } from "@/components/module-workspace";

export const metadata: Metadata = { title: "Operations" };

export default async function ModulePage({
  params,
}: {
  params: Promise<{ module: string }>;
}) {
  const { module } = await params;
  return <ModuleWorkspace module={module} />;
}
