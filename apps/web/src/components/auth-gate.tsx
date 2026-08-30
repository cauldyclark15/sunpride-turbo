"use client";

import { api } from "@sunpride/backend/api";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

const errorMessage = (error: unknown) => {
  if (error instanceof Error && error.message.includes("has not been invited"))
    return "This email address has not been invited to Sunpride Operations.";
  return "We could not provision this account. Contact the Sunpride super admin.";
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
        if (active) setProvisioningError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [ensureProfile, isAuthenticated]);

  if (isLoading || !isAuthenticated)
    return <LoadingScreen label="Opening Sunpride sign in…" />;
  if (provisioningError)
    return (
      <AccessMessage
        title="Access has not been provisioned"
        message={provisioningError}
      />
    );
  if (!profile || profile.status !== "active")
    return <LoadingScreen label="Verifying your Sunpride access…" />;
  return <>{children}</>;
}

export function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background text-sm font-medium text-muted">
      {label}
    </div>
  );
}

function AccessMessage({ title, message }: { title: string; message: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <section className="w-full max-w-md rounded-lg border border-border bg-surface p-8 text-center shadow-none">
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted">{message}</p>
      </section>
    </main>
  );
}
