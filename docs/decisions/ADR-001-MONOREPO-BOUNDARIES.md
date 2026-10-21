# ADR-001: Monorepo and backend boundaries

Status: accepted; updated for the v2 runtime.

Bun/Turborepo coordinate the API, management web, retained field-pilot notice, SAP mock and shared packages. `apps/api` owns online authentication, scoped business commands, sync, media, realtime and jobs. `packages/db` owns PostgreSQL migrations, row types and seeds. No generated backend client is required by an application build.

`apps/web` uses the in-house HTTP/auth layer and local DTOs. Android clients use native HTTP and encrypted local stores with `/api/sync`; iOS delivery is paused. The installable office app remains in `apps/web`, not the retired field pilot.

Shared presentation belongs in `packages/ui`, frozen native contracts in `packages/domain-contracts`, and SAP schemas in `packages/integration-contracts`. Business logic remains in API domains and SQL transactions. SAP mediation is one API domain, currently tested through `apps/sap-mock`; there is no separate legacy connector process.

See [SYSTEM](../architecture/SYSTEM.md) and the binding [backend contract](../architecture/BACKEND_V2.md).
