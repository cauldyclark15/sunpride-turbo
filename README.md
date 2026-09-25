# Sunpride Turbo

Sunpride’s integrated operations platform plans four user-facing products on one shared Convex backend/database: a Next.js management web app, native iOS and Android field-sales apps, and a separate native Android van POS. A JavaScript-only Bun connector bridges Convex and SAP. The native apps are planned, not yet present in this repository; the existing field PWA is frozen and will be retired after the native pilot ([ADR-004](docs/decisions/ADR-004-NATIVE-ANDROID-FIELD-AND-POS.md), [ADR-010](docs/decisions/ADR-010-NATIVE-FIELD-APPS-IOS-AND-ANDROID.md)).

## Workspace

| Path                                 | Runtime                          | Purpose                                                               |
| ------------------------------------ | -------------------------------- | --------------------------------------------------------------------- |
| `apps/web`                           | Next.js 16 / React 19            | Management, approvals, administration, analytics                      |
| `apps/pwa`                           | Vite / React 19                  | Frozen legacy field PWA; retire after native pilot                    |
| `apps/field-ios` _(planned)_         | Swift / SwiftUI                  | Native iOS field execution                                            |
| `apps/field-android` _(planned)_     | Kotlin / Jetpack Compose         | Native Android field execution                                        |
| `apps/van-sales-android` _(planned)_ | Kotlin / Jetpack Compose         | Separate Android van-sales POS and truck-stock execution              |
| `apps/sap-connector`                 | Bun JavaScript (no compile step) | Outbound-only bridge between local SAP and Convex                     |
| `packages/backend`                   | Convex                           | Database, Better Auth, realtime API, workflows, integration endpoints |
| `packages/ui`                        | HeroUI + HeroUI Pro              | Sunpride theme, logo, KPI, table, status, and layout primitives       |
| `packages/integration-contracts`     | JSON Schema                      | Versioned SAP integration envelopes and payloads                      |

## Start locally

Prerequisites: Bun 1.3.14 or newer and access to the configured Convex and HeroUI Pro accounts.

```bash
git clone git@github.com:cauldyclark15/sunpride-turbo.git
cd sunpride-turbo
bun install
bun run setup:env
bun run dev:backend
```

In separate terminals:

```bash
bun run dev:web
bun run dev:pwa # legacy PWA only; no new field features
bun run dev:sap
```

- Web: `http://localhost:3000`
- Legacy PWA: `http://localhost:5173` (frozen; not the planned field app)
- Connector health: `http://localhost:4100/health`
- Convex dashboard: `https://dashboard.convex.dev/t/cncit/sunpride-turbo/perceptive-grasshopper-340`

Access is invitation-only. The bootstrap migration reserves `jcing.jc@gmail.com` as the sole initial `super_admin`; arriving first never grants authority. The super admin can authorize the first administrators and users from Security & Admin, and administrators can provision non-admin users after that.

## Environment

Every runtime has a colocated, copy-ready `.env.example` containing the current
local development values:

```bash
cp packages/backend/.env.example packages/backend/.env.local
cp apps/web/.env.example apps/web/.env.local
cp apps/pwa/.env.example apps/pwa/.env.local
cp apps/sap-connector/.env.example apps/sap-connector/.env.local
```

Running `bun run setup:env` performs those copies without overwriting existing
files. It also retrieves `CONNECTOR_SIGNING_SECRET` from the configured Convex
deployment without displaying or committing it. Use `bun run setup:env --force`
only when you intentionally want to replace all four local files from the
examples.

The copied values connect the existing web app, legacy PWA and connector to the shared
`perceptive-grasshopper-340` development deployment. The
[`packages/backend/.env.deployment.example`](packages/backend/.env.deployment.example)
file lists the Convex-hosted settings needed when creating a different
deployment; its secret fields intentionally remain blank.

Better Auth uses email and password. Registration is blocked unless the email has a pending access invitation; the bootstrap email is always eligible. Run `bunx convex run migrations:bootstrapSuperAdmin` from `packages/backend` after pushing backend changes; it is idempotent.

Never expose SAP credentials or the connector signing secret to the web, legacy PWA or planned native apps. See [security controls](docs/security/SECURITY.md) and the [SAP connector runbook](docs/runbooks/SAP_CONNECTOR.md).

## Quality gate

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

See the [system architecture](docs/architecture/SYSTEM.md), [architecture decision index](docs/decisions/README.md) and [SFA delivery sequence](docs/delivery/SFA_DELIVERY_SEQUENCE.md) for the target products and rollout.
