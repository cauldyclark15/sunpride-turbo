import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";

const authServer = convexBetterAuthNextJs({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  convexSiteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL!,
});

export const handler = authServer.handler;
export const isAuthenticated = authServer.isAuthenticated;
