// SEAM(CALLFLOW): replace this reader with the canonical delivery domain's
// customer-safe projection. These are received status replicas, never a second
// delivery engine. The seed writes explicitly invented sample feed events only.
/** @param {any} db @param {string|null} orderId */
export async function deliveryStatus(db, orderId) {
  if (!orderId)
    return { milestones: [], source: "Delivery status not received" };
  const rows =
    await db`select stage,occurred_at,source from mt_delivery_status_replicas where order_id=${orderId} and occurred_at<=now() order by occurred_at,id limit 101`;
  if (rows.length > 100)
    return {
      milestones: [],
      source:
        "Delivery history exceeds this view; ask the account team for the full history",
    };
  return {
    milestones: rows.map((/** @type {any} */ r) => ({
      stage: r.stage,
      at: r.occurred_at,
    })),
    source: rows.length
      ? rows.some((/** @type {any} */ r) => r.source === "sample")
        ? "Sample delivery feed · invented demonstration data"
        : "Delivery status feed"
      : "Delivery status not received",
  };
}
