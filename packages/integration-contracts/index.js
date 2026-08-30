import envelope from "./sap/envelope.schema.json" with { type: "json" };
import inventory from "./sap/inventory.schema.json" with { type: "json" };
import masterData from "./sap/master-data.schema.json" with { type: "json" };
import salesOrder from "./sap/sales-order.schema.json" with { type: "json" };

export const contracts = { envelope, inventory, masterData, salesOrder };
