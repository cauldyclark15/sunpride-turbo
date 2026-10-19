"use client";

import { WorkspaceShell } from "@sunpride/ui";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { getWebNavigation } from "@/config/navigation";
import { useSession } from "@/lib/auth/session";
import { canAccessWebModule } from "@/lib/module-access";
import {
  AreaPendingNotice,
  BetaBar,
  needsAreaAssignment,
} from "./beta/beta-bar";

export function OperationsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession();
  const current = session.profile;
  const canSeeIssues = canAccessWebModule("issues", current?.role);
  const navigation = getWebNavigation(pathname, (slug) =>
    canAccessWebModule(slug, current?.role),
  );

  async function signOut() {
    await session.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <WorkspaceShell
      activeHref={pathname}
      activePrimaryId={navigation.activePrimaryId}
      brand={{
        logo: <Image src="/sunpride-logo.jpg" alt="" width={40} height={40} />,
        name: "Sunpride",
        descriptor: "Operations · Beta",
      }}
      contentWidth="full"
      navGroups={navigation.navGroups}
      onNavigate={(href) => router.push(href)}
      onSignOut={signOut}
      user={
        current
          ? {
              name: current.name,
              role: current.role,
            }
          : undefined
      }
    >
      <BetaBar pathname={pathname} canReport={canSeeIssues} />
      {needsAreaAssignment(current) ? <AreaPendingNotice /> : null}
      {children}
    </WorkspaceShell>
  );
}
