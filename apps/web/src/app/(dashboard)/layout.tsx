import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AuthGate } from "@/components/auth-gate";
import { OperationsShell } from "@/components/operations-shell";
import { isAuthenticated } from "@/lib/auth-server";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  if (!(await isAuthenticated())) redirect("/login");

  return (
    <AuthGate>
      <OperationsShell>{children}</OperationsShell>
    </AuthGate>
  );
}
