"use client";

import { Suspense, type ReactNode } from "react";
import type { OwnerSlug } from "@/config/navigation";
import { useSession } from "@/lib/auth/session";
import { canAccessWebModule } from "@/lib/module-access";
import { AccessDenied } from "../module-workspace";
import { PageSkeleton } from "./kit";

/**
 * Wraps an owner page: waits for the session, refuses roles the access map
 * does not open (UX only; the analytics endpoints enforce scope), and gives
 * `useSearchParams` its Suspense boundary.
 */
export function CockpitRoute({
  slug,
  children,
}: {
  slug: OwnerSlug;
  children: ReactNode;
}) {
  const { profile } = useSession();
  if (!profile) return <PageSkeleton />;
  if (!profile.active || !canAccessWebModule(slug, profile.role))
    return <AccessDenied />;
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}
