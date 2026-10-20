# V2 foundation exit gate

Run from an isolated lane, never a shared/live reset:

1. API: `bunx tsc -p jsconfig.json`, then `SP_LANE=<lane> bun run test` in `apps/api`.
2. DB: `bunx tsc -p jsconfig.json`, then `SP_LANE=<lane> bun test` in `packages/db`.
3. Web: `bunx tsc --noEmit`, `bunx vitest run`, `bun run lint`, `bunx next build` in `apps/web`.
4. SAP mock: `bun test` in `apps/sap-mock`.
5. Repository: `bun run audit:stack` and the credential audit.
6. Android: per-app JVM unit/lint/assemble using the existing Gradle wrapper and Android Studio JBR; physical suites are separate, authorized-device work.

Use current API `test/spec-integration.test.js`, `integration.test.js`, `imports.test.js`, `inventory.test.js`, `fieldsync.test.js`, `van.test.js` and `sap.test.js` for cross-domain behavior. Preserve real logs, counts, exits and initial failures. Never infer that a frozen v1 fixture parses the current v2 sync envelope. No cloud deployment/code generation is required by these gates. iOS is paused.
