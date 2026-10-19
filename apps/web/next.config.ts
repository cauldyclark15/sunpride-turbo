import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

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
    transpilePackages: ["@sunpride/ui", "@sunpride/backend"],
    async rewrites() {
      if (!proxyApi) return [];
      return [
        { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
        { source: "/ws", destination: `${apiOrigin}/ws` },
      ];
    },
  };
}
