import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["sunpride-logo.jpg"],
      manifest: {
        name: "Sunpride Field Operations",
        short_name: "Sunpride Field",
        description:
          "Offline-first field sales and order capture for Sunpride.",
        theme_color: "#ee1c25",
        background_color: "#fafafa",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/sunpride-logo.jpg",
            sizes: "1080x1080",
            type: "image/jpeg",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,jpg,svg,woff2}"],
      },
    }),
  ],
});
