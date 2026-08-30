# Sunpride Turbo

Sunpride’s integrated operations platform: a Next.js management web app, an offline-first React/Vite PWA, a JavaScript-only Bun SAP connector, and one shared Convex backend/database.

## Workspace

| Path                             | Runtime                          | Purpose                                                               |
| -------------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| `apps/web`                       | Next.js 16 / React 19            | Management, approvals, administration, analytics                      |
| `apps/pwa`                       | Vite / React 19                  | Installable offline-first field sales and order capture               |
| `apps/sap-connector`             | Bun JavaScript (no compile step) | Outbound-only bridge between local SAP and Convex                     |
| `packages/backend`               | Convex                           | Database, Better Auth, realtime API, workflows, integration endpoints |
| `packages/ui`                    | HeroUI + HeroUI Pro              | Sunpride theme, logo, KPI, table, status, and layout primitives       |
| `packages/integration-contracts` | JSON Schema                      | Versioned SAP integration envelopes and payloads                      |

## Start locally

Prerequisites: Bun 1.3.14 or newer and access to the configured Convex and HeroUI Pro accounts.

```bash
cd /Users/jc/cnc/sunpride-turbo
bun install
bun run dev:backend
```

In separate terminals:

```bash
bun run dev:web
bun run dev:pwa
bun run dev:sap
```

- Web: `http://localhost:3000`
- PWA: `http://localhost:5173`
- Connector health: `http://localhost:4100/health`
- Convex dashboard: `https://dashboard.convex.dev/t/cncit/sunpride-turbo/perceptive-grasshopper-340`

Access is invitation-only. The bootstrap migration reserves `jcing.jc@gmail.com` as the sole initial `super_admin`; arriving first never grants authority. The super admin can authorize the first administrators and users from Security & Admin, and administrators can provision non-admin users after that.

## Environment

Public app URLs are in each app’s ignored `.env.local`. Convex deployment selection is in `packages/backend/.env.local`. Copy `apps/sap-connector/.env.example` to `.env.local` and use the same signing secret stored as `CONNECTOR_SIGNING_SECRET` in the Convex deployment.

Better Auth uses email and password. Registration is blocked unless the email has a pending access invitation; the bootstrap email is always eligible. Run `bunx convex run migrations:bootstrapSuperAdmin` from `packages/backend` after pushing backend changes; it is idempotent.

Never expose SAP credentials or the connector signing secret to the web or PWA. See [security controls](docs/security/SECURITY.md) and the [SAP connector runbook](docs/runbooks/SAP_CONNECTOR.md).

## Quality gate

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

Architecture decisions and operational procedures are under [`docs/`](docs/architecture/SYSTEM.md).
