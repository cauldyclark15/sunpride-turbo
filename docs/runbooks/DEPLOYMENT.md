# Deployment runbook

1. Run `bun run check` from the repository root.
2. Configure `HEROUI_AUTH_TOKEN` for clean CI installs.
3. Configure production Convex environment values: `BETTER_AUTH_SECRET`, `SITE_URL`, `WEB_SITE_URL`, `PWA_SITE_URL`, and `CONNECTOR_SIGNING_SECRET`.
4. Deploy Convex from `packages/backend` with `bunx convex deploy`.
5. Deploy `apps/web` as the Next.js project with its public Convex cloud/site URLs.
6. Deploy `apps/pwa/dist` to HTTPS static hosting with SPA fallback and no-cache rules for `sw.js`.
7. Install the JavaScript-only connector on the client-managed Bun host, persist its `data/` directory, and configure restart supervision.
8. Run `bunx convex run migrations:bootstrapSuperAdmin` from `packages/backend`.
9. Create the first account with `jcing.jc@gmail.com`, confirm the `super_admin` role, then authorize the first administrators and users from Security & Admin.
10. Complete smoke tests: authentication, product/customer reads, offline order queue, approval, connector pull, SAP acknowledgement, audit evidence.

Rollback application binaries independently. Schema changes must remain backward compatible across the deployed web, PWA, and connector versions; integration contract version `1.0` remains accepted during any rolling upgrade.
