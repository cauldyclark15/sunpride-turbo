import { loadConfig } from "./config/index.js";
import { ConvexIntegrationClient } from "./convex/client.js";
import { DurableQueue } from "./queue/sqlite.js";
import { MockSapAdapter } from "./adapters/mock.js";
import { ODataSapAdapter } from "./adapters/odata.js";
import { ConnectorService } from "./service.js";

const config = loadConfig();
const queue = new DurableQueue(config.databasePath);
const convex = new ConvexIntegrationClient({
  baseUrl: config.convexIntegrationUrl,
  signingSecret: config.signingSecret,
});
const sap =
  config.adapter === "odata"
    ? new ODataSapAdapter({
        baseUrl: config.sapBaseUrl,
        username: config.sapUsername,
        password: config.sapPassword,
      })
    : new MockSapAdapter();
const service = new ConnectorService({ config, queue, convex, sap });

const server = Bun.serve({
  port: config.port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json(service.health());
    if (path === "/ready")
      return Response.json(
        { ready: service.lastSuccessfulCycle !== null },
        { status: service.lastSuccessfulCycle !== null ? 200 : 503 },
      );
    if (path === "/metrics") {
      const stats = service.health();
      return new Response(
        `sunpride_connector_up ${stats.status === "ok" ? 1 : 0}\nsunpride_connector_last_success_ms ${stats.lastSuccessfulCycle ?? 0}\n`,
        { headers: { "content-type": "text/plain; version=0.0.4" } },
      );
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

console.log(
  `Sunpride SAP connector listening on http://localhost:${server.port} with ${sap.name} adapter`,
);
await service.cycle();
const interval = setInterval(() => void service.cycle(), config.pollIntervalMs);

function shutdown() {
  clearInterval(interval);
  server.stop();
  queue.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
