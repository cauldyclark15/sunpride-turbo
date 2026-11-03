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
import { useMessagingUnread } from "@/lib/messaging/hooks";
import { unreadBadgeText } from "@/lib/messaging/nav-badge";
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
  const agency = session.me?.partner?.kind === "agency";
  useEffect(() => {
    if (agency && pathname !== "/agency" && pathname !== "/account")
      router.replace("/agency");
  }, [agency, pathname, router]);
  const canSeeIssues = canAccessWebModule("issues", current?.role);
  const unread = useMessagingUnread(
    !agency && canAccessWebModule("messages", current?.role)
      ? current?.subject
      : null,
  );
  const navigation = getWebNavigation(
    pathname,
    (slug) => canAccessWebModule(slug, current?.role),
    { messages: unreadBadgeText(unread) },
  );

  const phone = phoneTabsFor(current?.role, navigation.navGroups);

  async function signOut() {
    await session.signOut();
    router.replace("/login");
    router.refresh();
  }

  useEffect(() => {
    if (
      current?.role === "distributor" && !agency &&
      pathname !== "/distributor" &&
      pathname !== "/account"
    )
      router.replace("/distributor");
  }, [current?.role, agency, pathname, router]);

  if (agency)
    return (
      <div className="min-h-screen bg-background text-foreground">
        <header className="flex min-h-16 items-center justify-between gap-4 border-b border-border px-5">
          <div>
            <span className="font-semibold">Sunpride</span>
            <span className="ml-3 text-sm text-muted">Agency portal</span>
          </div>
          <div className="flex gap-4 text-sm">
            <button onClick={() => router.push("/account")}>Account</button>
            <button onClick={signOut}>Sign out</button>
          </div>
        </header>
        {current?.role === "sales" && pathname !== "/account" ? (
          <p className="p-6">
            Record your assigned work in the existing field app. Your agency
            coordinator reviews attendance and billing here.
          </p>
        ) : pathname === "/agency" || pathname === "/account" ? (
          children
        ) : (
          <p className="p-6">Opening your organisation portal…</p>
        )}
      </div>
    );

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
