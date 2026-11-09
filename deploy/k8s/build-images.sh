#!/usr/bin/env bash
# Build + push the Sunpride images (linux/amd64) tagged with the current git sha.
#   deploy/k8s/build-images.sh [api] [web] [sap-mock] [docs]   (default: all)
# Docker Hub creds: a temporary DOCKER_CONFIG filled from the cluster secret default/regcred.
set -euo pipefail
cd "$(dirname "$0")/../.."
SHA=${SHA:-$(git rev-parse --short=10 HEAD)}
REPO=${REPO:-cauldyclark15}
DOCS_DIR=${DOCS_DIR:-$HOME/cnc/_sites/sunpride-docs}
WEB_ENV=${WEB_ENV:-$HOME/cnc/sunpride-turbo/apps/web/.env.local}
targets=("$@"); [ ${#targets[@]} -eq 0 ] && targets=(api web sap-mock docs)
T=$(mktemp -d); trap 'rm -rf "$T" deploy/k8s/.vendor' EXIT; chmod 700 "$T"
export DOCKER_CONFIG="$T/docker"; mkdir -p "$DOCKER_CONFIG"
[ -d "$HOME/.docker/cli-plugins" ] && ln -s "$HOME/.docker/cli-plugins" "$DOCKER_CONFIG/cli-plugins"
kubectl --context lke495913-ctx -n default get secret regcred -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d > "$DOCKER_CONFIG/config.json"
for t in "${targets[@]}"; do
  case $t in
  web)
    [ -d node_modules ] || bun install
    mkdir -p deploy/k8s/.vendor
    cp -a "$(readlink -f packages/ui/node_modules/@heroui-pro/react)/." deploy/k8s/.vendor/heroui-pro-react/
    (umask 077; grep '^NEXT_PUBLIC_GOOGLE_MAPS_KEY=' "$WEB_ENV" | head -1 | cut -d= -f2- | tr -d '"\n' > "$T/maps_key")
    docker buildx build --platform linux/amd64 -f deploy/k8s/docker/web.Dockerfile \
      --secret id=maps_key,src="$T/maps_key" -t "$REPO/sunpride-web:$SHA" --push . ;;
  docs) docker buildx build --platform linux/amd64 -f deploy/k8s/docker/docs.Dockerfile -t "$REPO/sunpride-docs:$SHA" --push "$DOCS_DIR" ;;
  api|sap-mock) docker buildx build --platform linux/amd64 -f deploy/k8s/docker/$t.Dockerfile -t "$REPO/sunpride-$t:$SHA" --push . ;;
  *) echo "unknown target $t"; exit 2 ;;
  esac
done
echo "pushed tag $SHA: ${targets[*]}"
