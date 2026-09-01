export class MockSapAdapter {
  constructor() {
    this.name = "mock";
    this.emitted = false;
  }
  async pullChanges() {
    if (this.emitted) return [];
    this.emitted = true;
    return [
      {
        contractVersion: "1.0",
        eventId: "mock-inventory-SP-PJ-1L-WH-MNL",
        eventType: "inventory.snapshot",
        occurredAt: new Date().toISOString(),
        source: "sap",
        payload: {
          productCode: "SP-PJ-1L",
          warehouseCode: "WH-MNL",
          onHand: 240,
          reserved: 18,
          available: 222,
          asOf: new Date().toISOString(),
        },
      },
    ];
  }
  async submitEvent(task) {
    return {
      sapDocumentNumber: `MOCK-${task.eventType.toUpperCase().slice(0, 12)}-${task.eventId.slice(-8).toUpperCase()}`,
    };
  }
}
