import { v } from "convex/values";

export const trackingModeValidator = v.union(
  v.literal("none"),
  v.literal("lot"),
  v.literal("serial"),
);

export const allocationPolicyValidator = v.union(
  v.literal("fefo"),
  v.literal("fifo"),
  v.literal("explicit_only"),
);

export const costingMethodValidator = v.union(
  v.literal("weighted_average"),
  v.literal("fifo_layer"),
);

export const stockStatusValidator = v.union(
  v.literal("available"),
  v.literal("quality_hold"),
  v.literal("quarantine"),
  v.literal("damaged"),
  v.literal("expired"),
  v.literal("rejected"),
  v.literal("wip"),
  v.literal("in_transit"),
);

export type StockStatus =
  | "available"
  | "quality_hold"
  | "quarantine"
  | "damaged"
  | "expired"
  | "rejected"
  | "wip"
  | "in_transit";

export const locationTypeValidator = v.union(
  v.literal("warehouse"),
  v.literal("zone"),
  v.literal("bin"),
  v.literal("production"),
  v.literal("wip"),
  v.literal("truck"),
  v.literal("in_transit"),
  v.literal("returns"),
  v.literal("virtual_boundary"),
);

export const movementTypeValidator = v.union(
  v.literal("opening_balance"),
  v.literal("goods_receipt"),
  v.literal("inventory_issue"),
  v.literal("reservation"),
  v.literal("reservation_release"),
  v.literal("transfer_ship"),
  v.literal("transfer_receive"),
  v.literal("inventory_adjustment"),
  v.literal("status_change"),
  v.literal("pos_sale"),
  v.literal("pos_void"),
  v.literal("pos_return"),
  v.literal("production_issue"),
  v.literal("production_output"),
  v.literal("production_scrap"),
  v.literal("reversal"),
);

export type MovementType =
  | "opening_balance"
  | "goods_receipt"
  | "inventory_issue"
  | "reservation"
  | "reservation_release"
  | "transfer_ship"
  | "transfer_receive"
  | "inventory_adjustment"
  | "status_change"
  | "pos_sale"
  | "pos_void"
  | "pos_return"
  | "production_issue"
  | "production_output"
  | "production_scrap"
  | "reversal";

export const enteredQuantityValidator = v.object({
  quantity: v.string(),
  uomCode: v.string(),
});

export const explicitAllocationValidator = v.object({
  lotId: v.id("inventoryLots"),
  quantityBase: v.int64(),
});

export const postingLineValidator = v.object({
  productId: v.id("products"),
  quantityBase: v.int64(),
  enteredQuantity: v.optional(v.string()),
  enteredUomCode: v.optional(v.string()),
  fromLocationId: v.optional(v.id("inventoryLocations")),
  toLocationId: v.optional(v.id("inventoryLocations")),
  fromStockStatus: v.optional(stockStatusValidator),
  toStockStatus: v.optional(stockStatusValidator),
  allocations: v.optional(v.array(explicitAllocationValidator)),
  sourceLineId: v.optional(v.string()),
  unitCostMinor: v.optional(v.int64()),
  reasonCode: v.optional(v.string()),
});

export const movementResultValidator = v.object({
  movementId: v.id("inventoryMovements"),
  movementNumber: v.string(),
  duplicate: v.boolean(),
});

export const commandStatusValidator = v.union(
  v.literal("posted"),
  v.literal("rejected"),
  v.literal("review_required"),
);

export const reservationStatusValidator = v.union(
  v.literal("active"),
  v.literal("partially_consumed"),
  v.literal("consumed"),
  v.literal("released"),
  v.literal("expired"),
  v.literal("cancelled"),
);

export const transferStatusValidator = v.union(
  v.literal("draft"),
  v.literal("requested"),
  v.literal("approved"),
  v.literal("reserved"),
  v.literal("picking"),
  v.literal("shipped"),
  v.literal("partially_received"),
  v.literal("received"),
  v.literal("cancelled"),
  v.literal("review_required"),
);

export const receiptStatusValidator = v.union(
  v.literal("draft"),
  v.literal("in_inspection"),
  v.literal("partially_posted"),
  v.literal("posted"),
  v.literal("cancelled"),
  v.literal("review_required"),
);

export const approvalStatusValidator = v.union(
  v.literal("draft"),
  v.literal("submitted"),
  v.literal("approved"),
  v.literal("posted"),
  v.literal("rejected"),
  v.literal("reversed"),
);

export const productionStatusValidator = v.union(
  v.literal("draft"),
  v.literal("released"),
  v.literal("material_staged"),
  v.literal("in_progress"),
  v.literal("partially_completed"),
  v.literal("completed"),
  v.literal("cancelled"),
  v.literal("closed"),
  v.literal("review_required"),
);
