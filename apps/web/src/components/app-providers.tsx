"use client";

import type { ReactNode } from "react";
import { ApiProvider } from "@/lib/api/provider";
import { SessionProvider } from "@/lib/auth/session";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ApiProvider>
      <SessionProvider>{children}</SessionProvider>
    </ApiProvider>
  );
}
