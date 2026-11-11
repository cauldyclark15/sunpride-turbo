# --- shared: every workspace package.json (bun needs them all to honour the lockfile)
FROM oven/bun:1.3.14 AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out && cp package.json bun.lock /out/ \
 && find apps packages -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /out/ \;

FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY --from=manifests /out/ ./
RUN bun install --frozen-lockfile --ignore-scripts --filter @sunpride/web
# HeroUI Pro is licensed: its postinstall downloads dist/ with jc's login. Use the
# copy already installed on the build Mac (staged by deploy/k8s/build-images.sh).
COPY deploy/k8s/.vendor/heroui-pro-react/ /tmp/heroui-pro-react/
RUN d=$(readlink -f packages/ui/node_modules/@heroui-pro/react) && cp -a /tmp/heroui-pro-react/. "$d"/ && test -f "$d/dist/index.js" && rm -rf /tmp/heroui-pro-react
COPY packages/ui ./packages/ui
COPY packages/import-templates ./packages/import-templates
COPY packages/customer-master ./packages/customer-master
COPY packages/typescript-config ./packages/typescript-config
COPY packages/eslint-config ./packages/eslint-config
COPY apps/web ./apps/web
# Tests reach into other apps (api, android) that are not in this image; next build typechecks them.
RUN find apps/web packages/ui -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' | grep -v node_modules | xargs rm -f
ARG API_ORIGIN=http://sunpride-api:4320
ARG NEXT_PUBLIC_BETA_ENABLE=integration
ARG SP_BUILD_SHA=container
ENV NEXT_TELEMETRY_DISABLED=1 API_ORIGIN=$API_ORIGIN NEXT_PUBLIC_BETA_ENABLE=$NEXT_PUBLIC_BETA_ENABLE
# Public (browser) Maps key: passed as a BuildKit secret so it never lands in image history.
RUN --mount=type=secret,id=maps_key,required=false \
    cd apps/web && if [ -s /run/secrets/maps_key ]; then export NEXT_PUBLIC_GOOGLE_MAPS_KEY="$(cat /run/secrets/maps_key)"; fi \
 && bunx next build

FROM oven/bun:1.3.14-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 API_ORIGIN=http://sunpride-api:4320
COPY --from=build /app/ ./
USER bun
WORKDIR /app/apps/web
EXPOSE 4330
CMD ["bunx", "next", "start", "-p", "4330", "-H", "0.0.0.0"]
