export class ConnectorService {
  constructor({ config, queue, convex, sap, logger = console }) {
    this.config = config;
    this.queue = queue;
    this.convex = convex;
    this.sap = sap;
    this.logger = logger;
    this.running = false;
    this.lastSuccessfulCycle = null;
    this.lastError = null;
  }
  async cycle() {
    if (this.running) return;
    this.running = true;
    try {
      const changes = await this.sap.pullChanges();
      for (const event of changes)
        this.queue.enqueue({
          id: event.eventId,
          direction: "inbound",
          eventType: event.eventType,
          payload: event,
        });
      for (const item of this.queue.due("inbound")) {
        try {
          await this.convex.publish(item.payload);
          this.queue.complete(item.id);
        } catch (error) {
          this.queue.fail(item.id, error);
        }
      }
      const { tasks } = await this.convex.tasks();
      for (const task of tasks)
        this.queue.enqueue({
          id: task.eventId,
          direction: "outbound",
          eventType: task.eventType,
          payload: task,
        });
      for (const item of this.queue.due("outbound")) {
        try {
          const result = await this.sap.submitEvent(item.payload);
          await this.convex.acknowledge({
            eventId: item.id,
            success: true,
            sapDocumentNumber: result.sapDocumentNumber,
          });
          this.queue.complete(item.id);
        } catch (error) {
          this.queue.fail(item.id, error);
          try {
            await this.convex.acknowledge({
              eventId: item.id,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          } catch (ackError) {
            this.logger.error("Unable to acknowledge failed task", ackError);
          }
        }
      }
      await this.convex.heartbeat({
        connectorId: this.config.connectorId,
        status: "online",
        adapter: this.sap.name,
        details: JSON.stringify(this.queue.stats()),
      });
      this.lastSuccessfulCycle = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error("Connector cycle failed", error);
      try {
        await this.convex.heartbeat({
          connectorId: this.config.connectorId,
          status: "degraded",
          adapter: this.sap.name,
          details: this.lastError,
        });
      } catch {
        /* Next cycle will retry. */
      }
    } finally {
      this.running = false;
    }
  }
  health() {
    return {
      status: this.lastError ? "degraded" : "ok",
      connectorId: this.config.connectorId,
      adapter: this.sap.name,
      lastSuccessfulCycle: this.lastSuccessfulCycle,
      lastError: this.lastError,
      queue: this.queue.stats(),
    };
  }
}
