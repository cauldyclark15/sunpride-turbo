# ADR-001: Monorepo and backend boundaries

Status: accepted.

- Bun is the package manager and runtime for workspace tooling and the SAP connector.
- Turborepo coordinates cached build, lint, typecheck, test, and deploy tasks.
- The main business web app uses Next.js App Router because the client charter requires Next.js.
- The field PWA uses React + Vite so service-worker and offline behavior remain explicit and independent of Next.js.
- The SAP connector stays JavaScript-only ESM and has no TypeScript or build step, allowing direct Bun execution on client infrastructure.
- One Convex package owns the backend. Apps consume generated public API types through `@sunpride/backend/api`.
- Shared presentation belongs in `@sunpride/ui`; shared transport definitions belong in `@sunpride/integration-contracts`. Domain business logic remains in Convex.
