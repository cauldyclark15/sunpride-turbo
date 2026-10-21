# Sunpride management web

Next.js App Router application using the shared Sunpride UI kit and the Bun API. Owner pages answer daily questions about sales, coverage, stores, stock, vans, cash and decisions; workflow screens retain scoped operational commands.

`src/lib/api` supplies `apiFetch`, `useApi`, `useApiPages`, `useLive` and `mutate`. `src/lib/auth` reads `/api/me`. DTOs are local web types; IDs are UUID strings, instants are epoch milliseconds, money is integer centavos. Server authorization is authoritative.

Use `API_ORIGIN` for the server-side connection and local same-origin `/api`/`/ws` rewrites. The office app manifest and service worker are part of this application. See [DATA_LAYER](docs/DATA_LAYER.md), [BACKEND_V2](../../docs/architecture/BACKEND_V2.md) and [ANALYTICS_V2](../../docs/architecture/ANALYTICS_V2.md).

Verify with `bunx tsc --noEmit`, `bunx vitest run`, `bun run lint` and `bunx next build`. Root `bun run audit:stack` checks repository technology boundaries; no generated backend client or cloud deployment is part of a web build.
