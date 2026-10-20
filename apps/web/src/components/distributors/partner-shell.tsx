"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "../../lib/auth/session";
import { buttonClass } from "./kit";

/** F-402/F-403: deliberately separate minimal partner chrome in the SAME web app. */
export function PartnerShell({ children }: { children: ReactNode }) {
  const session = useSession(),
    router = useRouter();
  async function signOut() {
    await session.signOut();
    router.replace("/login?next=%2Fdistributor");
    router.refresh();
  }
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background px-5 py-4">
        <Link
          href="/distributor"
          className="text-base font-semibold tracking-tight"
        >
          Sunpride{" "}
          <span className="ml-2 text-xs font-normal text-muted">
            Distributor portal
          </span>
        </Link>
        <nav
          aria-label="Partner account"
          className="flex items-center gap-3 text-sm"
        >
          <span className="hidden text-muted sm:inline">
            {session.profile?.name}
          </span>
          <Link className={buttonClass} href="/account">
            Account
          </Link>
          <button className={buttonClass} onClick={() => void signOut()}>
            Sign out
          </button>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-7xl px-5 py-6 sm:px-8 sm:py-8">
        {children}
      </main>
    </div>
  );
}
