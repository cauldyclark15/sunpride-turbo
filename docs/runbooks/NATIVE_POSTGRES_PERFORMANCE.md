# Native PostgreSQL bulk-seed performance

F-025: the 90-day seed/reset gate runs against a disposable database on the native PostgreSQL 17 server. Do not increase its existing timeouts or the seed's 60-second performance threshold to accommodate a configuration problem.

## Diagnose before tuning

1. Run the failing test alone and retain `uptime` with its complete output, up to five attempts for timing-only failures. Use the normal application role and URL file; never print the URL.
2. Inspect `pg_settings`, `pg_stat_checkpointer`, `pg_stat_wal` and checkpoint messages as the local database operator. Restored application tables may need `ANALYZE`, but fresh disposable fixtures are not a restore-statistics problem.
3. Benchmark the actual filesystem with PostgreSQL 17's `pg_test_fsync -f <scratch-file> -s 1`; never use a database file as the benchmark target.

The native host's 1GB WAL setting caused repeated WAL-pressure checkpoints 16-25 seconds apart during the unchanged reset regression. Repeated full-page images amplified the write volume. On its APFS filesystem, the one/two-write measurements were 39/81 microseconds for `open_datasync` versus 20/22 microseconds for `fdatasync`.

## Application-local bulk plans

The seed writer also sets `jit=off` and `work_mem=64MB` inside its own transaction, matching the existing reset and analytics transaction pattern. Native bulk imports should not spend their bounded test window compiling large transient plans or spilling small-memory hash/sort work. These settings are not application-role defaults or global server changes.

`seed/performance-settings.test.js` installs a database-side guard at the actual order insert, executes `seedDemo`, and checks that the caller's original JIT/work-memory settings return after commit and replay. The guard fails against the former writer and passes against the tuned writer. The full 90-day seed's existing performance assertion remains unchanged.

## Bound test pressure on the shared engine

A later diagnostic run hit PostgreSQL error 53300 (ordinary connection slots exhausted) while other native lanes were active. Do not increase the shared server's connection limit or grant reserved/superuser access to make a suite pass. Run the normal API command with `SP_TEST_CONCURRENCY=1 SP_LANE=core bun run test`. The runner still executes every selected file and preserves all test limits; it only prevents several disposable-file pools overlapping. With no override the existing maximum of four files remains unchanged. The explicit bound is validated and logged.

## Apply as the operator, not the application

The reproducible operator script is `packages/db/scripts/tune-native-postgres.sql`. It refuses a non-loopback server, any port other than 5432, a server outside PostgreSQL 17, or a non-superuser. It is not a schema migration. Confirm free disk headroom first: `max_wal_size` is a soft checkpoint target, not a hard disk-usage limit.

```sh
/opt/homebrew/opt/postgresql@17/bin/psql -X -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -U jc -d postgres \
  -f packages/db/scripts/tune-native-postgres.sql
```

This raises `max_wal_size` to 8GB and selects `fdatasync`, then reloads configuration without restarting the shared server. It does not disable `fsync`, `full_page_writes` or `synchronous_commit`, change application privileges/timezone, or touch a container.

Read back from a new connection after reload; the connection that requested reload can still show its old values:

```sh
/opt/homebrew/opt/postgresql@17/bin/psql -X -h 127.0.0.1 -U jc -d postgres -c \
  "select name,setting,unit,pending_restart from pg_settings where name in ('max_wal_size','wal_sync_method','fsync','full_page_writes','synchronous_commit') order by name"
```

Require `max_wal_size=8192` MB, `wal_sync_method=fdatasync`, all three durability settings `on`, and `pending_restart=false`. Then rerun the unchanged regression and the full database suite:

```sh
cd packages/db
uptime
SP_LANE=core bun test seed/demo.test.js --test-name-pattern 'CLI --reset removes exactly owned rows'
uptime
SP_LANE=core bun test
```

A timed-out test can also leave a rejected asynchronous database operation when teardown closes its pool. Preserve the original `ERR_POSTGRES_CONNECTION_CLOSED` output; do not suppress it or call the suite green. Confirm both the timeout and that secondary error disappear on a complete passing run.

To undo only this operator tuning, set `max_wal_size` back to `1GB`, set `wal_sync_method` back to `open_datasync`, reload and verify from a fresh connection. Do not restart the shared engine or alter unrelated application settings.
