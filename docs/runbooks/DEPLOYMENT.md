# Deployment runbook

1. Run `bun run check` from the repository root.
2. Use `packages/backend/.env.deployment.example` as the checklist for Convex
   environment values. Generate fresh values for `BETTER_AUTH_SECRET` and
   `CONNECTOR_SIGNING_SECRET`; never commit either secret.
3. Deploy Convex from `packages/backend` with `bunx convex deploy`.
4. Deploy `apps/web` as the Next.js project with its public Convex cloud/site URLs.
5. Deploy `apps/pwa/dist` to HTTPS static hosting with SPA fallback and no-cache rules for `sw.js`.
6. Install the JavaScript-only connector on the client-managed Bun host, persist its `data/` directory, and configure restart supervision.
7. Run `bunx convex run migrations:bootstrapSuperAdmin` from `packages/backend`.
8. Create the first account with `jcing.jc@gmail.com`, confirm the `super_admin` role, then authorize the first administrators and users from Security & Admin.
9. Run Inventory → **Set up inventory**. Confirm the control changes to **Inventory ready**. Import approved opening quantities through `inventory.setup.postOpeningBalances`; never synthesize stock from an SAP snapshot.
10. Complete smoke tests: authentication, product/customer reads, receipt → lot → balance → ledger trace, transfer ship/receive, blind count and independent approval, rolling-truck route/open/offline sale/sync/void, connector pull, SAP acknowledgement, reconciliation, and audit evidence.

Rollback application binaries independently. Schema changes must remain backward compatible across the deployed web, PWA, and connector versions; integration contract versions `1.0` and `1.1` remain accepted during any rolling upgrade. Never roll back an already posted movement by deleting rows; post an exact reversal.
