"use client";

import { WorkspaceShell } from "@sunpride/ui";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { PartnerShell } from "./distributors/partner-shell";
import { getWebNavigation } from "@/config/navigation";
import { phoneTabsFor, phoneTitleFor } from "@/config/phone-tabs";
import { useSession } from "@/lib/auth/session";
import { canAccessWebModule } from "@/lib/module-access";
import {
  AreaPendingNotice,
  BetaBar,
  needsAreaAssignment,
} from "./beta/beta-bar";
import { OfflineDataBanner } from "./pwa/pwa-runtime";

export function OperationsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession();
  const current = session.profile;
  const canSeeIssues = canAccessWebModule("issues", current?.role);
  const navigation = getWebNavigation(pathname, (slug) =>
    canAccessWebModule(slug, current?.role),
  );

  const phone = phoneTabsFor(current?.role, navigation.navGroups);

  async function signOut() {
    await session.signOut();
    router.replace("/login");
    router.refresh();
  }

  useEffect(() => {
    if (
      current?.role === "distributor" &&
      pathname !== "/distributor" &&
      pathname !== "/account"
    )
      router.replace("/distributor");
  }, [current?.role, pathname, router]);

  if (current?.role === "distributor")
    return (
      <PartnerShell>
        {pathname === "/distributor" || pathname === "/account" ? (
          children
        ) : (
          <p className="text-sm text-muted">Opening distributor portal…</p>
        )}
      </PartnerShell>
    );

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
      phoneTabs={current ? phone.tabs : undefined}
      phoneMoreItems={phone.more}
      phoneTitle={phoneTitleFor(pathname)}
      onNavigate={(href) => router.push(href)}
      onSignOut={signOut}
      onAccount={() => router.push("/account")}
      user={
        current
          ? {
              name: current.name,
              role: current.role,
            }
          : undefined
      }
    >
      <OfflineDataBanner />
      <BetaBar pathname={pathname} canReport={canSeeIssues} />
      {needsAreaAssignment(current) ? <AreaPendingNotice /> : null}
      {children}
    </WorkspaceShell>
  );
}
