# --- shared: every workspace package.json (bun needs them all to honour the lockfile)
FROM oven/bun:1.3.14 AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out && cp package.json bun.lock /out/ \
 && find apps packages -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /out/ \;

FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY --from=manifests /out/ ./
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @sunpride/api

FROM oven/bun:1.3.14-slim
# Linux replacements for the Mac-only tools the api shells out to:
#  - MT OCR (ocr.swift / Apple Vision) -> tesseract + eng, poppler for PDFs (scripts/ocr-tesseract.js)
#  - APK release inspection (aapt + apksigner from the Android SDK) -> Debian's aapt/apksigner
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils aapt apksigner \
 && rm -rf /var/lib/apt/lists/* \
 && aapt version && apksigner --version && tesseract --version | head -1
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4320
COPY --from=deps /app/ ./
COPY packages/db ./packages/db
COPY packages/integration-contracts ./packages/integration-contracts
COPY apps/api ./apps/api
RUN rm -rf apps/api/**/*.test.js 2>/dev/null; mkdir -p /data/files && chown -R bun:bun /data
USER bun
WORKDIR /app/apps/api
EXPOSE 4320
CMD ["bun", "src/server.js"]
