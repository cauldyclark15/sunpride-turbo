import { execSync } from "node:child_process";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

/** One id per build: the service worker names its caches after it. */
function buildVersion() {
  let commit = "local";
  try {
    commit = execSync("git rev-parse --short=10 HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // Not a git checkout (container build): the timestamp alone is unique.
  }
  return `${commit}-${Date.now().toString(36)}`;
}

/**
 * The Bun API (BACKEND_V2 §3). Behind the tunnel `/api` and `/ws` never reach
 * Next; in local dev (or whenever API_ORIGIN is set) these rewrites forward
 * them so web and API share an origin and the `sp_session` cookie stays
 * same-site.
 */
export default function nextConfig(phase: string): NextConfig {
  const apiOrigin = process.env.API_ORIGIN || "http://127.0.0.1:4310";
  const proxyApi =
    phase === PHASE_DEVELOPMENT_SERVER || Boolean(process.env.API_ORIGIN);
  return {
    devIndicators: false,
    transpilePackages: ["@sunpride/ui"],
    env: { NEXT_PUBLIC_SP_BUILD_ID: buildVersion() },
    async headers() {
      return [
        {
          // The PWA guide: the worker itself is never cached, so updates land.
          source: "/sw.js",
          headers: [
            {
              key: "Content-Type",
              value: "application/javascript; charset=utf-8",
            },
            {
              key: "Cache-Control",
              value: "no-cache, no-store, must-revalidate",
            },
            {
              key: "Content-Security-Policy",
              value: "default-src 'self'; script-src 'self'",
            },
          ],
        },
      ];
    },
    async redirects() {
      // Kick-off presentation: a static deck in public/kickoff, outside the sign-in gate.
      return [
        { source: "/kickoff", destination: "/kickoff/index.html", permanent: false },
      ];
    },
    async rewrites() {
      if (!proxyApi) return [];
      return [
        { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
        { source: "/ws", destination: `${apiOrigin}/ws` },
      ];
    },
  };
}
