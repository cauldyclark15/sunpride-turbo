export function loadConfig(env = process.env) {
  const config = {
    convexIntegrationUrl: env.CONVEX_INTEGRATION_URL,
    signingSecret: env.CONNECTOR_SIGNING_SECRET,
    connectorId: env.CONNECTOR_ID ?? "sunpride-local-01",
    adapter: env.SAP_ADAPTER ?? "mock",
    sapBaseUrl: env.SAP_BASE_URL,
    sapUsername: env.SAP_USERNAME,
    sapPassword: env.SAP_PASSWORD,
    databasePath: env.CONNECTOR_DB_PATH ?? "data/connector.sqlite",
    pollIntervalMs: Number(env.SAP_POLL_INTERVAL_MS ?? 15_000),
    port: Number(env.CONNECTOR_PORT ?? 4100),
  };
  if (!config.convexIntegrationUrl)
    throw new Error("CONVEX_INTEGRATION_URL is required");
  if (!config.signingSecret)
    throw new Error("CONNECTOR_SIGNING_SECRET is required");
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 1_000)
    throw new Error("SAP_POLL_INTERVAL_MS must be at least 1000");
  if (
    config.adapter === "odata" &&
    (!config.sapBaseUrl || !config.sapUsername || !config.sapPassword)
  )
    throw new Error(
      "SAP_BASE_URL, SAP_USERNAME, and SAP_PASSWORD are required for the odata adapter",
    );
  return config;
}
