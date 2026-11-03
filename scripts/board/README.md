# Board automation CLI

Run from the repository root with Bun. `DATABASE_URL` must be supplied by the
caller; there is no fallback database or credential-file lookup.

```sh
bun scripts/board.js list --status need_to_rectify,draft --limit 20
bun scripts/board.js list --updated-since 2026-01-01T00:00:00Z
bun scripts/board.js show SP-0001
bun scripts/board.js comments --since 2026-01-01T00:00:00Z --status ongoing_test
bun scripts/board.js create --title 'Order cannot be saved' --area Orders --priority high --ref OPS-example
bun scripts/board.js move SP-0001 --status dev_work_ongoing --comment 'Picked up for investigation'
bun scripts/board.js comment SP-0001 --body 'Verified against the lane database'
```

All successful commands emit one JSON value to stdout. Errors emit
`{"error":"code","message":"Plain words"}` to stderr. Exit codes are 0 for
success, 2 for invalid usage, 3 for a missing issue, and 1 for other failures.
Timestamps are ISO-8601 instants with an explicit timezone.

- `list` exports active issues in priority/rank order. With no `--limit`, it
  exports every match. `--updated-since` and comment `--since` are exclusive.
- `show` includes the complete non-deleted conversation and attachment URLs
  (same-origin API paths; downloading them still requires authentication).
- Hermes is provisioned once as an active super administrator with an empty,
  unusable password hash. Existing disabled/demoted identities are refused, not
  silently re-enabled. Commands do not issue a session or accept an actor override.
- Team classification uses the author's email, never the displayed label. Hermes
  is always team; other team emails come from
  `~/.sunpride-keys/team-emails.txt`, one per line, case-insensitively. A missing
  file is allowed. `TEAM_EMAILS_FILE` overrides the file path, including in tests.
- `create --ref` returns the existing issue with `existing: true` on replay,
  without editing it. Concurrent HTTP/CLI writes share the board advisory lock.
- A same-status `move` is a no-op, including its optional `--comment`. Use the
  separate `comment` command when only a comment is intended. Other moves and
  their optional comments commit atomically.
- Mutations use the issue service and sync change log, then publish both board
  and detail invalidations after commit. CLI retries without `--ref` (and comment
  retries) are not deduplicated; there is no HTTP idempotency-key CLI option.

Tests use only the disposable database created by the API harness:

```sh
cd apps/api
SP_LANE=opsboard bun test test/board-cli.test.js
```
