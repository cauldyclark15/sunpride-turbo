import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppProviders } from "@/components/app-providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Sunpride Operations", template: "%s · Sunpride" },
  description:
    "Integrated sales, inventory, workflow, and SAP operations for Sunpride.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="light">
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
