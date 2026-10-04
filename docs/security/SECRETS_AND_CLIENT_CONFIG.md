# Secrets and client configuration (QSR-008)

Rule: SAP credentials, signing secrets and privileged keys live only on the
server side (Convex deployment environment or the connector host). They never
appear in Git, in anything shipped to a browser or phone, or in logs and error
reports. `bun run audit:secrets` enforces the parts a machine can check; the
rest is the release checklist at the end.

## Inventory

| Name                                                                                                                                   | Class           | Lives in                                            | Read by                            | Notes                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`                                                                                                                   | Secret          | Convex deployment env                               | Convex (`convex.config.ts`)        | Session signing. Per deployment.                                               |
| `CONNECTOR_SIGNING_SECRET`                                                                                                             | Secret          | Convex deployment env + connector host `.env.local` | `convex/http.ts`, connector        | HMAC for `/api/sap/*`. `bun run setup:env` copies it locally without printing. |
| `MOBILE_CURSOR_SECRET`                                                                                                                 | Secret          | Convex deployment env                               | `convex/mobile/cursor.ts`          | ≥ 32 chars; mobile sync fails closed without it.                               |
| `SAP_USERNAME`, `SAP_PASSWORD`                                                                                                         | Secret          | Connector host `.env.local` only                    | `apps/sap-connector` OData adapter | Never in Convex, never in Turbo global env.                                    |
| `CONVEX_DEPLOY_KEY`                                                                                                                    | Privileged key  | CI secret store only                                | `convex deploy`                    | Never in a file in the repo.                                                   |
| `CONVEX_DEPLOYMENT`                                                                                                                    | Internal        | `packages/backend/.env.local`                       | Convex CLI                         | Deployment name, not a credential.                                             |
| `CONVEX_URL`, `CONVEX_SITE_URL`, `SITE_URL`, `WEB_SITE_URL`, `PWA_SITE_URL`                                                            | Public          | Convex env / local env                              | backend, CLI scripts               | Origins only.                                                                  |
| `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL`, `NEXT_PUBLIC_SITE_URL`                                                        | Public, inlined | `apps/web/.env.local` / host                        | web browser bundle                 | Inlined into JS by design.                                                     |
| `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, `VITE_SITE_URL`                                                                             | Public, inlined | `apps/pwa/.env.local`                               | PWA bundle (frozen app)            | Inlined into JS by design.                                                     |
| `SUNPRIDE_<FLAVOR>_CONVEX_URL` / `_CONVEX_SITE_URL`                                                                                    | Public, inlined | `apps/field-android/local.properties` (ignored)     | Android `BuildConfig`              | URL validated as a bare origin (`AppEnvironment.kt`).                          |
| `CONVEX_URL`, `CONVEX_SITE_URL`                                                                                                        | Public, inlined | `apps/field-ios/Config/Local.xcconfig` (ignored)    | iOS Info.plist                     | URL validated as a bare origin (`AppEnvironment.swift`).                       |
| `CONNECTOR_ID`, `SAP_ADAPTER`, `SAP_BASE_URL`, `SAP_POLL_INTERVAL_MS`, `CONNECTOR_PORT`, `CONNECTOR_DB_PATH`, `CONVEX_INTEGRATION_URL` | Internal        | Connector host                                      | connector                          | Not credentials.                                                               |

The native apps hold no shared secret at all: each phone generates its own
device key in Keychain / Android Keystore and authenticates with the user's
short-lived session (ADR-020, `docs/contracts/MOBILE_AUTH_V1.md`).

## What the audit enforces

`scripts/secret-audit.ts` (tests: `scripts/secret-audit.test.ts`, part of
`bun run test`). `bun run build` runs the bundle half after every build;
`bun run check` runs both halves.

Repository (`--repo`, every tracked file):

- No tracked credential files: `.env`, `.env.*` other than `*.example`,
  `local.properties`, `Local.xcconfig`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`,
  `*.keystore`, `*.p8`, `*.mobileprovision`.
- Tracked env/xcconfig/properties templates keep every secret-named assignment
  blank.
- No credential shapes: PEM private-key blocks, JWTs, AWS/GitHub/Slack/Stripe
  live keys, Convex deploy keys.
- No secret value known on this machine (any secret-named value in a local
  `.env*` file or the process environment) appears in a tracked file.
- Browser source (`apps/web/src`, `apps/pwa/src`, `packages/ui/src`) reads only
  `process.env.NEXT_PUBLIC_*` / `NODE_ENV` and `import.meta.env.VITE_*` (or
  Vite's built-ins); a file that needs anything else must `import "server-only"`.
- `next.config` has no `env:` block; `vite.config` does not widen `envPrefix`
  or `define` from `process.env`.
- `turbo.json` files put no secret name in `globalEnv` or the `build` task env.
  Connector variables are pass-through on the connector's `dev` task only
  (`apps/sap-connector/turbo.json`), so `next build` / `vite build` never
  receive SAP or signing secrets.
- Native sources (`apps/field-android`, `apps/field-ios`) never name a server
  secret.

Bundles (`--bundles`, `apps/web/.next/static`, `apps/pwa/dist`, and Android
`BuildConfig` sources when built):

- None of the known secret values above appear.
- The names `CONNECTOR_SIGNING_SECRET`, `MOBILE_CURSOR_SECRET`, `SAP_USERNAME`,
  `SAP_PASSWORD`, `CONVEX_DEPLOY_KEY` do not appear (they would mean server code
  was bundled). `BETTER_AUTH_SECRET`/`AUTH_SECRET` are allowed as names only:
  the better-auth client ships an environment getter that names them and
  resolves to nothing in a browser.
- No credential shapes.

The audit prints file, rule and variable name only — never a value.

## Logs and error reports

- SAP connector: every error is passed through `src/redact.js` before it is
  logged, stored in the local queue (`last_error`), shown on `/health`, or sent
  to Convex in a task acknowledgement or heartbeat. It removes the signing
  secret, the SAP password (raw and URL-encoded) and the Basic credential,
  masks `Basic`/`Bearer` tokens and `password=`/`secret=`/`token=` pairs, drops
  stack traces and caps messages at 500 characters. Upstream response bodies in
  errors are cut to 300 characters. Tested in `test/redact.test.js`.
- Convex: `http.ts` logs only a fixed message plus the internal error; request
  signatures and bodies are not logged. Mobile device proofs and audit rows store
  codes, never tokens (see `MOBILE_DEVICE_INCIDENT.md`).
- iOS: OSLog dynamic values are `.private`; support exports pass a redactor
  (`SecurityHygieneTests`). Android: logs only allow-listed codes via a
  debug-only wrapper.

## Audit result (2026-10-04)

- History: the only non-empty secret assignment ever committed is the original
  `apps/sap-connector/.env.example` placeholder (`replace-…`), which differs from
  the live value. No PEM keys, JWTs or credential files in any commit.
- Web and PWA production bundles: no secret values or server secret names.
- Fixed: Turbo previously listed `CONNECTOR_SIGNING_SECRET`, `SAP_USERNAME` and
  `SAP_PASSWORD` in `globalEnv`, handing them to every task including the web and
  PWA builds. Now connector-only.
- Fixed: connector errors could carry raw SAP/Convex response bodies and full
  stack traces into logs, `/health` and Convex heartbeats; now redacted and
  bounded.
- Fixed: `MOBILE_CURSOR_SECRET` was missing from
  `packages/backend/.env.deployment.example`.

## Release checklist (people, not software)

1. Generate new `BETTER_AUTH_SECRET`, `CONNECTOR_SIGNING_SECRET` and
   `MOBILE_CURSOR_SECRET` for production; never copy DEV values.
2. Store `CONVEX_DEPLOY_KEY` only in the CI secret store; restrict who can read
   Convex production env.
3. SAP: a dedicated least-privilege technical user for the connector, password
   held only on the connector host, file mode 0600, rotated on staff change.
4. Confirm the connector `/health` port is not exposed beyond the host.
5. Rotate every secret immediately if it is ever pasted into chat, a ticket or
   a log; then rerun `bun run audit:secrets`.
