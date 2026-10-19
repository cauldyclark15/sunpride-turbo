"use client";

import { useEffect, type ReactNode } from "react";
import { defaultApiStore } from "@/lib/api";
import { SESSION_KEY } from "@/lib/auth/client";
import type { Me } from "@/lib/auth/types";
import { useSession } from "@/lib/auth/session";
import { TARGET_MANAGERS } from "@/lib/module-access";
import { LoadingScreen } from "../auth-gate";

export const FIXTURE_ROLES = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
  "sales",
  "analyst",
  "viewer",
] as const;

const NAMES: Record<string, string> = {
  super_admin: "Francis Uy",
  admin: "Loren Abellana",
  operations: "Ops Desk",
  manager: "Cristina Go",
  approver: "Approver Desk",
  sales: "Joy Villanueva",
  analyst: "Analyst",
  viewer: "Viewer",
};

export function fixtureMe(role: string): Me {
  const safeRole = (FIXTURE_ROLES as readonly string[]).includes(role)
    ? role
    : "super_admin";
  return {
    profile: {
      id: `fixture-${safeRole}`,
      subject: `fixture|${safeRole}`,
      name: NAMES[safeRole] ?? "Demo user",
      role: safeRole,
      orgUnitId: "u-cebu",
      active: true,
    },
    scope: null,
    permissions: [
      "report.read",
      ...((TARGET_MANAGERS as readonly string[]).includes(safeRole)
        ? ["target.manage"]
        : []),
    ],
  };
}

/**
 * Development only (`/fixture` sets the cookie; the dashboard layout checks
 * NODE_ENV): seeds a demo session so the cockpit can be reviewed against the
 * contract fixtures without the API.
 */
export function FixtureSession({
  role,
  children,
}: {
  role: string;
  children: ReactNode;
}) {
  const { profile } = useSession();
  // Seed after mount: the server render and the first client render both
  // show the loading screen, so hydration matches.
  useEffect(() => {
    if (!profile || profile.role !== role)
      defaultApiStore.setData([...SESSION_KEY], fixtureMe(role));
  }, [profile, role]);
  if (!profile) return <LoadingScreen label="Loading demo session…" />;
  return <>{children}</>;
}
