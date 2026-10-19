import type { MetadataRoute } from "next";
import { APP_SURFACE } from "@/config/app-theme";

/**
 * Web app manifest: office leaders install the management app on a phone.
 * Sunpride red stays in the icon artwork; the chrome uses the calm surface.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Sunpride Operations",
    short_name: "Sunpride",
    description:
      "Sales, coverage, stock, vans and approvals for Sunpride office leaders.",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    background_color: APP_SURFACE,
    theme_color: APP_SURFACE,
    categories: ["business", "productivity"],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
