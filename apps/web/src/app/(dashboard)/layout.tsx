import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthGate } from "@/components/auth-gate";
import { FixtureSession } from "@/components/cockpit/fixture-session";
import { OperationsShell } from "@/components/operations-shell";
import { isAuthenticated } from "@/lib/auth-server";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Development only: `/fixture` sets this cookie so the cockpit can be
  // reviewed against the contract fixtures without the API or a session.
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- NODE_ENV is set by Next itself.
  if (process.env.NODE_ENV !== "production") {
    const jar = await cookies();
    if (jar.get("sp_fixture")?.value === "1")
      return (
        <FixtureSession
          role={jar.get("sp_fixture_role")?.value ?? "super_admin"}
        >
          <OperationsShell>{children}</OperationsShell>
        </FixtureSession>
      );
  }

  if (!(await isAuthenticated())) redirect("/login");

  return (
    <AuthGate>
      <OperationsShell>{children}</OperationsShell>
    </AuthGate>
  );
}
