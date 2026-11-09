#!/usr/bin/env bash
# Copy Sunpride data from the Mac (live, READ-ONLY) into the k8s namespace.
# Used for the phase-1 test copy and again at cutover (after the freeze).
#
#   deploy/k8s/copy-data.sh [db] [files] [sap]      (default: all three)
#
# Env (all optional):
#   SRC_DB_URL_FILE  file holding the source DATABASE_URL (default ~/.sunpride-keys/pg-dev-url)
#   SRC_FILES_DIR    api FILES_DIR on the Mac           (default ~/sunpride-data/files)
#   SRC_SAP_DB       sap-mock sqlite on the Mac          (default ~/sunpride-data/sap-mock.sqlite)
#   KCTX / NS        kube context / namespace            (default lke495913-ctx / sunpride)
#   DUMP_DIR         where the local dump is kept        (default ~/sunpride-data/k8s-copy)
#
# The source is only read (pg_dump, sqlite3 .backup, tar). Nothing secret is printed.
set -euo pipefail
umask 077
KCTX=${KCTX:-lke495913-ctx}
NS=${NS:-sunpride}
SRC_DB_URL_FILE=${SRC_DB_URL_FILE:-$HOME/.sunpride-keys/pg-dev-url}
SRC_FILES_DIR=${SRC_FILES_DIR:-$HOME/sunpride-data/files}
SRC_SAP_DB=${SRC_SAP_DB:-$HOME/sunpride-data/sap-mock.sqlite}
DUMP_DIR=${DUMP_DIR:-$HOME/sunpride-data/k8s-copy}
k() { kubectl --context "$KCTX" -n "$NS" "$@"; }
steps=("$@"); [ ${#steps[@]} -eq 0 ] && steps=(db files sap)
mkdir -p "$DUMP_DIR"; chmod 700 "$DUMP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)

# Run a throwaway pod that mounts PVC $1 at /data, then stream stdin into `sh -c $2` there.
with_pvc() {
  local pvc=$1 cmd=$2 pod="sp-copy-$RANDOM"
  k run "$pod" --image=busybox:1.36 --restart=Never --overrides="$(cat <<JSON
{"spec":{"securityContext":{"fsGroup":1000},"containers":[{"name":"c","image":"busybox:1.36","command":["sleep","3600"],
"securityContext":{"runAsUser":1000,"runAsGroup":1000},
"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"cpu":"200m","memory":"64Mi"}},
"volumeMounts":[{"name":"d","mountPath":"/data"}]}],
"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"$pvc"}}]}}
JSON
)" >/dev/null
  k wait --for=condition=Ready "pod/$pod" --timeout=180s >/dev/null
  k exec -i "$pod" -- sh -c "$cmd"
  k delete pod "$pod" --wait=true >/dev/null  # free the RWO volume before the app pod reattaches it
}

for s in "${steps[@]}"; do case $s in
db)
  f="$DUMP_DIR/sunpride-$stamp.dump"
  echo "[db] pg_dump (read-only) -> $f"
  pg_dump -Fc --no-owner --no-acl -d "$(cat "$SRC_DB_URL_FILE")" -f "$f"
  ls -lh "$f"
  echo "[db] stopping api (so nothing writes during restore)"
  k scale deploy/sunpride-api --replicas=0 2>/dev/null || true
  k wait --for=delete pod -l app=sunpride-api --timeout=120s 2>/dev/null || true
  echo "[db] recreate target database"
  k exec sunpride-pg-0 -- psql -U sunpride -d postgres -v ON_ERROR_STOP=1 -q \
    -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='sunpride' and pid<>pg_backend_pid()" \
    -c "drop database if exists sunpride" -c "create database sunpride owner sunpride"
  k exec sunpride-pg-0 -- psql -U sunpride -d sunpride -v ON_ERROR_STOP=1 -q \
    -c "create extension if not exists vector" -c "create extension if not exists btree_gist" \
    -c "create extension if not exists citext" -c "create extension if not exists pgcrypto"
  echo "[db] pg_restore"
  k exec -i sunpride-pg-0 -- pg_restore -U sunpride -d sunpride --no-owner --no-acl --exit-on-error < "$f" \
    || { echo "[db] pg_restore reported errors"; exit 1; }
  k exec sunpride-pg-0 -- psql -U sunpride -d sunpride -q -c "analyze"
  k scale deploy/sunpride-api --replicas=1 2>/dev/null || true
  # keep the last 3 local copies
  ls -1t "$DUMP_DIR"/sunpride-*.dump | tail -n +4 | xargs -r rm -f
  ;;
files)
  echo "[files] $SRC_FILES_DIR -> pvc sunpride-api-files"
  k scale deploy/sunpride-api --replicas=0 2>/dev/null || true
  k wait --for=delete pod -l app=sunpride-api --timeout=120s 2>/dev/null || true
  tar -C "$SRC_FILES_DIR" -cf - . | with_pvc sunpride-api-files 'find /data -mindepth 1 -delete; tar -C /data -xf - && du -sh /data && find /data -type f | wc -l'
  k scale deploy/sunpride-api --replicas=1 2>/dev/null || true
  ;;
sap)
  echo "[sap] $SRC_SAP_DB -> pvc sunpride-sap-mock-data"
  snap="$DUMP_DIR/sap-mock-$stamp.sqlite"
  sqlite3 "file:$SRC_SAP_DB?mode=ro" ".backup '$snap'"
  k scale deploy/sunpride-sap-mock --replicas=0 2>/dev/null || true
  k wait --for=delete pod -l app=sunpride-sap-mock --timeout=120s 2>/dev/null || true
  with_pvc sunpride-sap-mock-data 'rm -f /data/sap-mock.sqlite /data/sap-mock.sqlite-wal /data/sap-mock.sqlite-shm; cat > /data/sap-mock.sqlite && ls -l /data' < "$snap"
  rm -f "$snap"
  k scale deploy/sunpride-sap-mock --replicas=1 2>/dev/null || true
  ;;
*) echo "unknown step $s (db|files|sap)"; exit 2 ;;
esac; done
echo "done."
