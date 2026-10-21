# In-app issue board

The v2 board is implemented by `apps/api/src/domains/issues` and PostgreSQL `issues`, `issue_comments`, `issue_attachments`, `issue_activity` and `issue_counters`. The management web uses `/api/v1/issues` through the shared data/auth layer. Server capability checks remain authoritative for reading, tester feedback, triage and moderation.

Use `bun scripts/issues.ts --help` for the current agent CLI. It calls the Bun API, reading its private token from the configured local key file; never place token values in commands or comments. The CLI source documents the supported actions and payloads. A board write must be read back before reporting success.

The old export is not a bundled default seed. `seedIssues(db, {file})` in `packages/db/seed/issues.js` requires an explicit authorized archive path and imports only supplied facts, without overwriting existing numbers or inventing missing body/comment/attachment evidence. Existing PostgreSQL board data is not reset by this cleanup.

Verify `apps/api/src/domains/issues/issues.test.js` with the isolated API runner. Native/client builds, upload storage limits and public deployment are separate checks.
