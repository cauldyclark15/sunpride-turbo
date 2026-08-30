export class ODataSapAdapter {
  constructor({ baseUrl, username, password }) {
    this.name = "odata";
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authorization = `Basic ${btoa(`${username}:${password}`)}`;
  }
  async call(path, init = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: this.authorization,
        accept: "application/json",
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(
        `SAP OData request failed: ${response.status} ${await response.text()}`,
      );
    return response.json();
  }
  async pullChanges() {
    const result = await this.call(
      "/InventorySet?$top=100&$orderby=LastChangeDateTime asc",
    );
    return (result.value ?? result.d?.results ?? []).map((item) => ({
      contractVersion: "1.0",
      eventId: `inventory-${item.Material}-${item.Plant}-${item.LastChangeDateTime}`,
      eventType: "inventory.snapshot",
      occurredAt: item.LastChangeDateTime ?? new Date().toISOString(),
      source: "sap",
      payload: {
        productCode: item.Material,
        warehouseCode: item.Plant,
        onHand: Number(item.OnHand ?? 0),
        reserved: Number(item.Reserved ?? 0),
        available: Number(item.Available ?? 0),
        asOf: item.LastChangeDateTime ?? new Date().toISOString(),
      },
    }));
  }
  async submitOrder(task) {
    const result = await this.call("/SalesOrderSet", {
      method: "POST",
      body: JSON.stringify(task.payload),
    });
    return { sapDocumentNumber: result.SalesOrder ?? result.d?.SalesOrder };
  }
}
