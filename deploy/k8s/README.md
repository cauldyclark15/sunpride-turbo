# Sunpride on Linode LKE (namespace `sunpride`)

Temporary cloud hosting on jc's LKE cluster (`lke495913-ctx`). Other production apps share the
cluster: **touch only namespace `sunpride`**. Shared things we only read: IngressClass `nginx`,
ClusterIssuer `cnc-cert`, secret `default/regcred` (copied into `sunpride`).

## What runs

| Workload | Kind | Image | Requests / limits | Storage |
|---|---|---|---|---|
| `sunpride-pg` | StatefulSet (1) | `pgvector/pgvector:0.8.7-pg17` | 250m/1Gi · 1/2Gi | PVC `data-sunpride-pg-0` 20Gi |
| `sunpride-api` (+ `sap-mock` sidecar, `migrate` init) | Deployment (1, Recreate) | `cauldyclark15/sunpride-api`, `-sap-mock` | api 200m/384Mi · 1/1Gi; sap 20m/64Mi | `sunpride-api-files` 10Gi, `sunpride-sap-mock-data` 10Gi |
| `sunpride-web` | Deployment (1) | `cauldyclark15/sunpride-web` | 100m/256Mi · 1/768Mi | – |
| `sunpride-docs` | Deployment (1) | `cauldyclark15/sunpride-docs` (nginx-unprivileged) | 10m/16Mi | – |
| `sunpride-pg-backup` | CronJob 02:00 Asia/Manila | pgvector image (`pg_dump -Fc`, keep 7) | 50m/64Mi | `sunpride-pg-backups` 20Gi |

Notes
- sap-mock is a **sidecar in the api pod** on 127.0.0.1:4435: `apps/api/src/domains/integration/transport.js`
  refuses `SAP_MODE=mock` unless `SAP_ORIGIN` is localhost.
- Linode block storage has a 10Gi minimum, so the api-files and sap-mock volumes are 10Gi.
- RWO volumes ⇒ api is `Recreate`; a pod restart is ~50 s of api downtime (volume detach/attach).
- Ingress: `^/(api|ws|sync|healthz)(/.*)?$` → api:4320, everything else → web:4330 (same as the tunnel),
  3600 s proxy read/send timeouts for `/ws`, TLS from `cnc-cert` (HTTP-01).

## Secrets (never committed, never printed)

```bash
K=~/.sunpride-keys; T=$(mktemp -d)        # values read from files only
kubectl -n sunpride create secret generic sunpride-pg --from-file=password=$K/k8s-pg-password
printf 'postgres://sunpride:%s@sunpride-pg:5432/sunpride' "$(cat $K/k8s-pg-password)" > $T/DATABASE_URL
tr -d '\n' < $K/v2-sync-cursor-secret > $T/SYNC_CURSOR_SECRET
tr -d '\n' < $K/v2-sap-mock-token      > $T/SAP_TOKEN
tr -d '\n' < $K/google-maps-key        > $T/GOOGLE_MAPS_SERVER_KEY
kubectl -n sunpride create secret generic sunpride-app --from-file=$T/DATABASE_URL \
  --from-file=$T/SYNC_CURSOR_SECRET --from-file=$T/SAP_TOKEN --from-file=$T/GOOGLE_MAPS_SERVER_KEY
rm -rf $T
kubectl -n default get secret regcred -o json | jq '{apiVersion,kind,type,data,metadata:{name:"regcred",namespace:"sunpride"}}' | kubectl apply -f -
```

## Build + apply order

1. `deploy/k8s/build-images.sh` — builds linux/amd64 images tagged with `git rev-parse --short=10 HEAD`
   and pushes to Docker Hub with a temporary `DOCKER_CONFIG` from `default/regcred`.
   The web image needs HeroUI Pro's licensed `dist/` (installed on this Mac by `bun install` with jc's
   HeroUI login); the script stages it into the build context (gitignored) and deletes it after.
   `NEXT_PUBLIC_GOOGLE_MAPS_KEY` is passed as a BuildKit secret from `apps/web/.env.local` of the live checkout.
2. Bump `newTag` in `kustomization.yaml`.
3. `kubectl apply -f 00-namespace.yaml`, create the secrets above.
4. `kubectl --context lke495913-ctx apply -k deploy/k8s` (Postgres, api+sap-mock, web, docs, ingress, backups).
5. `deploy/k8s/copy-data.sh [db] [files] [sap]` — read-only pg_dump of the Mac DB → restore into k8s;
   files dir and sap-mock sqlite (sqlite `.backup`, read-only) into their volumes. Scales the api to 0 while copying.
6. Verify: `curl https://<host>/healthz` → `{"ok":true,"db":true}`.

Backups: nightly CronJob on the cluster; `~/.hermes/scripts/sunpride-k8s-backup-pull.sh` copies the newest
dump to `~/sunpride-data/k8s-backups/` (keeps 14) — schedule it after 02:00 Manila.
Manual run: `kubectl -n sunpride create job --from=cronjob/sunpride-pg-backup sunpride-pg-backup-manual-$(date +%s)`.

## Cutover runbook (proposal — not done in phase 1)

Prep (day before, no impact)
- Rebuild images from the main commit being cut over (`build-images.sh`), bump tags, `apply -k`; check test host.
- Add `sunpride.cauldnclark.com` (and `docs.cauldnclark.com`) to `60-ingress.yaml` (own TLS secrets);
  change `PUBLIC_ORIGIN` in `sunpride-api-env` to `https://sunpride.cauldnclark.com`. Don't apply yet.
- Lower the TTL of nothing (the tunnel records are proxied CNAMEs; Cloudflare flips are near-instant).
- Rehearse: `time deploy/k8s/copy-data.sh` (phase 1: ≈5 min for db, <1 min files+sap).
- Tell users: ~15 min maintenance window; native apps queue offline and resync.

Freeze → copy → flip (T0)
1. Freeze writes on the Mac: stop **only** the api agent (`launchctl bootout gui/$UID/com.cauldnclark.sunpride.api`)
   — web keeps serving a sign-in page/errors; record the live `schema_migrations` head.
   Pause Mac jobs that write the live DB (demo-daily seed, pickup lanes, release.py).
2. `deploy/k8s/copy-data.sh db files sap` (api in k8s is scaled to 0 during it, then back to 1).
3. Compare row counts of the 10 biggest tables (same query as the phase-1 report) + `select max(seq)` style checks.
4. `kubectl apply -k deploy/k8s` with the prod host + PUBLIC_ORIGIN; wait for the api pod Ready.
5. Cloudflare: replace the `sunpride` (and `docs`) tunnel CNAME with **A 143.42.79.95, DNS-only** so
   cert-manager HTTP-01 can issue (≈1–2 min; watch `kubectl -n sunpride get certificate`). Optionally turn the
   proxy back on afterwards (SSL mode must then be Full/Strict).
6. Verify on the real host: `/healthz` db true, sign-in, `/today`, two-client `/ws` invalidation, an Android
   and iPhone sync, one SAP-mock flow.
7. Leave the Mac launchd agents stopped-but-installed for rollback; stop the tunnel route for the host only
   after a day of green.

Rollback (any time before Mac data is discarded)
- Restore the `sunpride` CNAME to the tunnel (proxied), `launchctl bootstrap` the api agent back.
- Writes made on k8s after T0 are lost unless carried back: `kubectl exec sunpride-pg-0 -- pg_dump -Fc` →
  `pg_restore --clean` into the Mac DB (inverse of copy-data.sh), and copy `/data/files` back.

Expected downtime: ≈10–15 min (freeze + ~5 min restore + api start + cert issue/DNS), most of it the restore.

## After cutover: Mac-side things that still point at the Mac

See `~/cnc/_plans/sunpride-inv-pos/reports/K8S-PHASE1.md` (“Cutover planning”) for the full list:
`sunpride-ops/common.py` + `pickup.py` + `scripts/board.js` (live DB via `pg-dev-url`), `release.py`
(`SP_OPS_API=http://127.0.0.1:4320` and APK inspection with the Mac's Android SDK), `sunpride-demo-daily.sh`
(seed via `pg-dev-url`), `sunpride-docs-publish.py` (writes `~/cnc/_sites/sunpride-docs`, served by the Mac),
`landing_context.py` (`deployed-sha`). Each needs either a DB URL through
`kubectl -n sunpride port-forward svc/sunpride-pg 15432:5432` or the public API URL.
