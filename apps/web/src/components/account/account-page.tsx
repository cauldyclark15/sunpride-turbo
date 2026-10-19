"use client";

import { apiFetch, useApi } from "../../lib/api";
import { useSession } from "../../lib/auth/session";
import { ChangePassword } from "./change-password";

const ROLE_NAMES: Record<string, string> = {
  super_admin: "System administrator",
  admin: "Administrator",
  manager: "Sales manager or supervisor",
  sales: "Field agent or van seller",
  operations: "Operations",
  approver: "Approver",
  analyst: "Analyst",
  viewer: "Viewer",
};

type Unit = { id: string; name: string };

export function AccountPage() {
  const { profile } = useSession();
  const units = useApi<Unit[]>(
    profile?.orgUnitId ? ["account-area", profile.id, profile.orgUnitId] : null,
    ({ signal }) => apiFetch<Unit[]>("/api/v1/org/tree", { signal }),
  );
  if (!profile) return null;
  const area = profile.orgUnitId
    ? (units.data?.find((unit) => unit.id === profile.orgUnitId)?.name ??
      (units.error ? "Area unavailable. Try again shortly." : "Loading area…"))
    : ["super_admin", "analyst"].includes(profile.role)
      ? "All areas"
      : "No area assigned yet";

  return (
    <main className="mx-auto grid w-full max-w-3xl gap-6 py-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="mt-2 text-sm text-muted">
          Your sign-in details and password.
        </p>
      </header>
      <section
        aria-label="Your details"
        className="rounded-2xl border border-border bg-surface p-5 sm:p-6"
      >
        <dl className="grid gap-5 text-sm sm:grid-cols-2">
          {[
            ["Name", profile.name],
            ["Email", profile.email ?? "Email unavailable"],
            ["Role", ROLE_NAMES[profile.role] ?? "Team member"],
            ["Area", area],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-muted">{label}</dt>
              <dd className="mt-1 break-words font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <ChangePassword />
    </main>
  );
}
