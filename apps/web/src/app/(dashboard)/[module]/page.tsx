import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ModuleWorkspace } from "@/components/module-workspace";
import { isModuleHiddenForBeta } from "@/config/beta";
import { isWebModuleSlug } from "@/config/navigation";

export const metadata: Metadata = { title: "Operations" };

export default async function ModulePage({
  params,
}: {
  params: Promise<{ module: string }>;
}) {
  const { module } = await params;
  // Beta release: modules on the beta feature list are hidden, not deleted.
  if (!isWebModuleSlug(module) || isModuleHiddenForBeta(module)) notFound();
  return <ModuleWorkspace module={module} />;
}
