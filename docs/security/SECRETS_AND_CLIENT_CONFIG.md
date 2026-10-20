# Secrets and client configuration

## Current boundary

Server credentials live outside the repository in private environment variables or ignored local files. The API and PostgreSQL replace hosted backend configuration. `bun run setup:env` copies local templates only; it never calls a cloud CLI or retrieves remote secrets.

| Name | Location/use |
| --- | --- |
| `DATABASE_URL` | Private API/migration environment; includes database credentials |
| `SYNC_CURSOR_SECRET` | Private API environment; cursor/approval signing |
| `SAP_TOKEN` | Private API environment for real SAP mediation |
| `API_ORIGIN` | Next server-side API connection, never a browser credential |
| `SAP_MODE`, `SAP_ORIGIN`, `SAP_TIMEOUT_MS` | API mediation configuration; local mock is the development default |
| `FILES_DIR`, `PORT`, `HOST`, `BOOTSTRAP_ADMIN_EMAILS` | API host configuration |
| `NEXT_PUBLIC_SITE_URL`, beta and map variables | Explicit public browser build values; browser map key must have referrer/API restrictions |
| `SUNPRIDE_<FLAVOR>_API_ORIGIN` | Native API origin, not an administrator credential |

Native refresh/session tokens and private device keys belong only in platform secure storage; signing material stays outside source control. Never put passwords, tokens, GPS evidence or database URLs in argv, screenshots, test summaries or committed docs. Development test vectors are labelled test-only and never enrollment keys.

## Gates

`bun run audit:secrets` scans tracked configuration and built client bundles without printing values. It recognizes generic secret-name/credential shapes and current API/SAP secret names. The Next server module using `next/headers` is a server boundary. Only the exact public worker build-ID expression is allowed as a Next `env` exception; arbitrary env inlining stays refused. Run the audit's tests when changing that policy.

`bun run audit:stack` independently rejects retired technology references across source, tests, lockfiles, docs and native config. Only lead-owned v2 architecture contracts and write-protected instructions are exempt; this is not permission to ship their historical operational guidance in a native app.

Run local checks with private lane URL files, not shared production credentials. Build gates do not prove deployment or secret rotation. If an actual credential is exposed, rotate only the affected account/key through its authorized owner and verify it privately.
