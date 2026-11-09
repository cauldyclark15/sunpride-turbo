FROM oven/bun:1.3.14-slim
WORKDIR /app/apps/sap-mock
ENV HOST=0.0.0.0 PORT=4435 SAP_MOCK_DB=/data/sap-mock.sqlite
COPY apps/sap-mock/package.json ./
COPY apps/sap-mock/src ./src
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 4435
CMD ["bun", "src/server.js"]
