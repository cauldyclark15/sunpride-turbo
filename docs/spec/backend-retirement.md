# Backend retirement — platform cleanup

## Scope

The supported runtime is Bun API + native PostgreSQL 17, `/api/sync`, and the existing web/native transports. Retired backend functions, generated bindings and the standalone SAP connector are removed. SAP mediation stays in `apps/api/src/domains/integration` against `apps/sap-mock`; no new business feature or parallel engine is introduced.

## Preserved behavior

No management page or ordinary native operation is rewritten. Web production changes are dependency/config cleanup and comments only. Parity tests now check current API constants/constraints or frozen independent baseline grants rather than importing a deleted server package. The office PWA remains in `apps/web`.

The separate frozen field-pilot package cannot submit to v2 safely. It displays a retirement notice instead of its old sign-in, registration, Today, ordering, stock, catalog and sync routes. IndexedDB storage and its tests remain; the notice neither erases nor automatically replays retained evidence. Supervised reconciliation precedes recapture.

## Repository gate

`bun run audit:stack` scans tracked and new non-ignored text, filenames, native configuration, docs and lockfiles. It excludes only the exact two lead-owned v2 architecture contracts and any write-protected instructions named `CLAUDE.md`. The guard avoids matching its own token and reports locations, never content values. The existing native binary packaging guard remains.

## Schema and archives

Historical provenance comments and generated row annotations are removed. Two unused baseline reconciliation columns use the neutral names `operational_cutoff` and `operational_base`, matching their row typedefs. No API reads or writes those baseline fields. No forward migration is added and no shared/live database is altered; already applied databases can retain their unused historical column labels. The schema remains table/constraint compatible for ordinary domain behavior.

Issue import now requires an explicit archive file instead of a deleted external backup default. It does not reset or rewrite an existing PostgreSQL board.

## Needs Sunpride

None. This is platform retirement, not a new policy or invented business dataset.

## iOS parity later

iOS remains paused. Only the obsolete UI-test name check is removed; the existing configuration assertion and binary packaging guard remain. No iOS runtime feature, rebuild or installation is part of this change.

## Integration

Run `bun install` and `bun run audit:stack`, then lint/typecheck/build the touched packages. Keep already-passing test results; rerun only a changed or previously failing test file. Do not rebuild native apps for this deletion-only integration. The lead runs the full merged gate once before release. Do not edit the exempt lead-owned contracts or protected instructions as part of merging this lane. Visual before/after evidence and exact executed check results belong in the external lane report, not in a committed execution log.
