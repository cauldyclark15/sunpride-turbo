import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppProviders } from "@/components/app-providers";
import { PwaRuntime } from "@/components/pwa/pwa-runtime";
import { APP_SURFACE } from "@/config/app-theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Sunpride Operations", template: "%s · Sunpride" },
  description: "Sales, inventory, field and approval operations for Sunpride.",
  applicationName: "Sunpride Operations",
  appleWebApp: {
    capable: true,
    title: "Sunpride",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: APP_SURFACE,
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="light">
      <body>
        <AppProviders>{children}</AppProviders>
        <PwaRuntime />
      </body>
    </html>
  );
}
