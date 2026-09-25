import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ModuleWorkspace } from "@/components/module-workspace";
import { isWebModuleSlug } from "@/config/navigation";

export const metadata: Metadata = { title: "Operations" };

export default async function ModulePage({
  params,
}: {
  params: Promise<{ module: string }>;
}) {
  const { module } = await params;
  if (!isWebModuleSlug(module)) notFound();
  return <ModuleWorkspace module={module} />;
}
