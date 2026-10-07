"use client";

import { api } from "@sunpride/backend/api";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";

export const accessErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message.includes("has not been invited"))
    return "This email address has not been invited yet. Ask your administrator to invite it, or sign out and use the email address your invitation was sent to.";
  return "Access unavailable. Contact your administrator.";
};

export function AuthGate({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const ensureProfile = useMutation(api.domains.profiles.ensure);
  const profile = useQuery(
    api.domains.profiles.current,
    isAuthenticated ? {} : "skip",
  );
  const pathname = usePathname();
  const router = useRouter();
  const [provisioningError, setProvisioningError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (isLoading || isAuthenticated) return;
    const next = pathname.startsWith("/") ? pathname : "/dashboard";
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [isAuthenticated, isLoading, pathname, router]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let active = true;
    void ensureProfile()
      .then(() => {
        if (active) setProvisioningError(null);
      })
      .catch((error: unknown) => {
        if (active) setProvisioningError(accessErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [ensureProfile, isAuthenticated]);

  if (isLoading || !isAuthenticated) return <LoadingScreen label="Loading…" />;
  if (provisioningError)
    return (
      <AccessMessage title="Access unavailable" message={provisioningError} />
    );
  // A turned-off profile would otherwise wait on "Loading…" forever.
  if (profile && profile.status !== "active")
    return (
      <AccessMessage
        title="Access turned off"
        message="Your access to Sunpride Operations has been turned off. Contact your administrator."
      />
    );
  if (!profile) return <LoadingScreen label="Loading…" />;
  return <>{children}</>;
}

export function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background text-sm font-medium text-muted">
      {label}
    </div>
  );
}

/** A dead end for the gate, so it always offers a way out: sign out or read the guide. */
export function AccessMessage({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  const router = useRouter();
  async function signOut() {
    await authClient.signOut();
    router.replace("/login");
    router.refresh();
  }
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <section className="w-full max-w-md rounded-lg border border-border bg-surface p-8 text-center shadow-none">
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted">{message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => void signOut()}
            className="h-9 rounded-lg border border-border bg-surface px-4 font-medium text-foreground hover:bg-default-soft"
          >
            Sign out
          </button>
          <Link
            href="/help"
            className="inline-flex h-9 items-center px-2 font-medium text-muted hover:text-foreground"
          >
            Help for testers
          </Link>
        </div>
      </section>
    </main>
  );
}
