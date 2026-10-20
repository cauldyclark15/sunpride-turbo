import { enqueueSapPosting } from "./outbox.js";

/** @param {any} l */
function line(l) {
  return {
    productCode: l.productCode,
    uom: l.uom,
    quantityBase: Number(l.quantityBase),
    lotId: l.lotId ?? null,
    fromLocationCode: l.fromLocationCode ?? null,
    toLocationCode: l.toLocationCode ?? null,
    unitPriceCentavos: l.unitPriceCentavos ?? null,
    taxCode: l.taxCode ?? null,
    taxBasisPoints: l.taxBasisPoints ?? null,
  };
}
/** @param {any} db @param {string|null} id */
async function creditSnapshot(db, id) {
  if (!id) return null;
  const [r] =
    await db`select decision_token,amount_centavos,checked_at,expires_at from sap_credit_decisions where id=${id}`;
  return r
    ? {
        token: r.decision_token,
        amountCentavos: Number(r.amount_centavos),
        checkedAt: new Date(r.checked_at).getTime(),
        expiresAt: new Date(r.expires_at).getTime(),
      }
    : null;
}
/** F-119 immutable order price/tax snapshot is the payload; never reconstruct at retry.
 * @param {any} db @param {any} order
 */
export async function enqueueOrderPosting(db, order) {
  const p = order.pricing_snapshot;
  return enqueueSapPosting(db, {
    kind: "order",
    sourceType: "order",
    sourceId: order.id,
    orgUnitId: order.org_unit_id,
    document: {
      sourceType: "order",
      sourceId: order.id,
      customerCode: order.customer_code,
      currency: "PHP",
      amountCentavos: Number(order.total_centavos),
      occurredAt: new Date(
        order.offline_created_at ?? order.created_at,
      ).getTime(),
      lines: p.lines.map((/** @type {any} */ l) => line(l)),
      facts: {
        orderNumber: order.order_number,
        serviceDate: order.service_date,
        pricing: p,
        creditDecisionId: order.sap_credit_decision_id ?? null,
        creditDecision: await creditSnapshot(db, order.sap_credit_decision_id),
      },
    },
  });
}
/** F-119 existing stock writer remains sole quantity owner; this only queues its frozen facts.
 * @param {any} db @param {string} movementId
 */
export async function enqueueMovementPosting(db, movementId) {
  const [m] =
    await db`select * from inventory_movements where id=${movementId}`;
  const [trip] =
    await db`select trip_id from van_sales where ${m.source_type}='van_sale' and id::text=${m.source_document_id}
    union all select trip_id from van_sale_voids where ${m.source_type}='van_sale_void' and id::text=${m.source_document_id}
    union all select trip_id from van_returns where ${m.source_type}='van_return' and id::text=${m.source_document_id}
    union all select trip_id from van_trip_loads where ${m.source_type}='van_trip_load' and id::text=${m.source_document_id}
    union all select trip_id from van_damage_records where ${m.source_type}='van_damage_record' and id::text=${m.source_document_id}
    union all select trip_id from van_stock_counts where ${m.source_type}='van_stock_count' and id::text=${m.source_document_id}
    union all select id as trip_id from van_trips where ${m.source_type}='van_trip' and id::text=${m.source_document_id}`;
  const dependencies =
    m.source_type === "van_sale"
      ? [`invoice:van_sale:${m.source_document_id}`]
      : m.source_type === "van_sale_void"
        ? [`credit_memo:van_void:${m.source_document_id}`]
        : m.source_type === "van_return"
          ? [`credit_memo:van_return:${m.source_document_id}`]
          : [];
  const rows =
    await db`select ml.*,p.code as product_code,src.code as from_code,dst.code as to_code,src.sap_plant as from_plant,src.sap_storage_location as from_storage,dst.sap_plant as to_plant,dst.sap_storage_location as to_storage
    from inventory_movement_lines ml join products p on p.id=ml.product_id left join inventory_locations src on src.id=ml.from_location_id left join inventory_locations dst on dst.id=ml.to_location_id where ml.movement_id=${movementId} order by ml.line_number`;
  const queued = await enqueueSapPosting(db, {
    kind: "goods_movement",
    dependsOn: dependencies,
    sourceType: "movement",
    sourceId: movementId,
    document: {
      sourceType: "movement",
      sourceId: movementId,
      customerCode: null,
      currency: "PHP",
      amountCentavos: null,
      occurredAt: new Date(
        m.occurred_at ?? m.effective_at ?? m.created_at,
      ).getTime(),
      lines: rows.map((/** @type {any} */ r) =>
        line({
          productCode: r.product_code,
          uom: r.entered_uom_code,
          quantityBase: Number(r.quantity_base),
          lotId: r.lot_id,
          fromLocationCode: r.from_code,
          toLocationCode: r.to_code,
        }),
      ),
      facts: {
        tripId: trip?.trip_id ?? null,
        valuationMode: "sap_derive",
        kind: m.kind ?? m.movement_type,
        sourceType: m.source_type,
        sourceId: m.source_document_id,
        allocations:
          await db`select a.* from inventory_allocations a where a.movement_id=${movementId}`,
        locations: rows.map((/** @type {any} */ r) => ({
          fromCode: r.from_code,
          toCode: r.to_code,
          fromPlant: r.from_plant,
          fromStorage: r.from_storage,
          toPlant: r.to_plant,
          toStorage: r.to_storage,
        })),
      },
    },
  });
  await db`update integration_events set movement_id=${movementId},source_document_id=${m.source_document_id} where id=${queued.id}`;
  return queued;
}
/** @param {any} db @param {any} trip @param {string} saleId */
export async function enqueueVanInvoice(db, trip, saleId) {
  const [sale] = await db`select * from van_sales where id=${saleId}`;
  const receipt = sale.receipt;
  return enqueueSapPosting(db, {
    kind: "invoice",
    sourceType: "van_sale",
    sourceId: saleId,
    orgUnitId: trip.org_unit_id,
    document: {
      sourceType: "van_sale",
      sourceId: saleId,
      customerCode: sale.customer_code,
      currency: "PHP",
      amountCentavos: Number(sale.total_centavos),
      occurredAt: receipt.soldAt,
      lines: receipt.lines.map((/** @type {any} */ l) =>
        line({
          productCode: l.code,
          uom: l.uomCode,
          quantityBase: l.quantityBase,
          unitPriceCentavos: Number(l.unitPriceMinor),
          taxCode: l.taxCode,
          taxBasisPoints: l.taxBasisPoints,
        }),
      ),
      facts: {
        tripId: trip.id,
        receipt,
        creditDecisionId: sale.sap_credit_decision_id ?? null,
        creditDecision: await creditSnapshot(db, sale.sap_credit_decision_id),
      },
    },
  });
}
/** @param {any} db @param {any} trip @param {string} id */
export async function enqueueVanPayment(db, trip, id) {
  const [p] =
    await db`select p.*,s.customer_code from van_payments p left join van_sales s on s.id=p.sale_id where p.id=${id}`;
  // Account credit is not a cash receipt. It is represented on the invoice only.
  if (p.method === "credit") return null;
  if (p.sale_id) await enqueueVanInvoice(db, trip, p.sale_id);
  const [voidRecord] =
    p.kind === "void_refund"
      ? await db`select id from van_sale_voids where sale_id=${p.sale_id}`
      : [];
  return enqueueSapPosting(db, {
    kind: "payment",
    dependsOn: [
      ...(p.sale_id ? [`invoice:van_sale:${p.sale_id}`] : []),
      ...(p.return_id ? [`credit_memo:van_return:${p.return_id}`] : []),
      ...(voidRecord ? [`credit_memo:van_void:${voidRecord.id}`] : []),
    ],
    sourceType: "van_payment",
    sourceId: id,
    orgUnitId: trip.org_unit_id,
    document: {
      sourceType: "van_payment",
      sourceId: id,
      customerCode: p.customer_code ?? null,
      currency: "PHP",
      amountCentavos: Number(p.amount_centavos),
      occurredAt: new Date(p.created_at).getTime(),
      lines: [],
      facts: {
        tripId: trip.id,
        saleId: p.sale_id,
        returnId: p.return_id,
        kind: p.kind,
        method: p.method,
        payment: p.facts,
      },
    },
  });
}
/** @param {any} db @param {any} trip @param {string} id */
export async function enqueueVanCreditMemo(db, trip, id) {
  const [r] = await db`select * from van_returns where id=${id}`;
  if (r.sale_id) await enqueueVanInvoice(db, trip, r.sale_id);
  const rows =
    await db`select l.*,p.code from van_return_lines l join products p on p.id=l.product_id where return_id=${id} order by ordinal`;
  const [sale] = r.sale_id
    ? await db`select customer_code from van_sales where id=${r.sale_id}`
    : [];
  return enqueueSapPosting(db, {
    kind: "credit_memo",
    sourceType: "van_return",
    dependsOn: r.sale_id ? [`invoice:van_sale:${r.sale_id}`] : [],
    sourceId: id,
    orgUnitId: trip.org_unit_id,
    document: {
      sourceType: "van_return",
      sourceId: id,
      customerCode: sale?.customer_code ?? null,
      currency: "PHP",
      amountCentavos: null,
      occurredAt: new Date(r.created_at).getTime(),
      lines: rows.map((/** @type {any} */ l) =>
        line({
          productCode: l.code,
          uom:
            l.facts.uom ?? l.facts.uomCode ?? l.facts.product?.baseUom ?? "PC",
          quantityBase: l.quantity_base,
          lotId: l.facts.lotId,
        }),
      ),
      facts: {
        tripId: trip.id,
        saleId: r.sale_id,
        returnNumber: r.return_number,
        captured: r.captured_request,
        lines: rows.map((/** @type {any} */ l) => l.facts),
        instruction:
          "SAP determines credit value; a physical return is not automatic local credit",
      },
    },
  });
}
/** F-119 independent approved void becomes an SAP credit instruction, never an erased invoice.
 * @param {any} db @param {any} trip @param {string} id
 */
export async function enqueueVanVoidCreditMemo(db, trip, id) {
  const [v] =
    await db`select v.*,s.receipt,s.customer_code,s.total_centavos from van_sale_voids v join van_sales s on s.id=v.sale_id where v.id=${id}`;
  await enqueueVanInvoice(db, trip, v.sale_id);
  return enqueueSapPosting(db, {
    kind: "credit_memo",
    sourceType: "van_void",
    sourceId: id,
    orgUnitId: trip.org_unit_id,
    dependsOn: [`invoice:van_sale:${v.sale_id}`],
    document: {
      sourceType: "van_void",
      sourceId: id,
      customerCode: v.customer_code,
      currency: "PHP",
      amountCentavos: Number(v.total_centavos),
      occurredAt: new Date(v.created_at).getTime(),
      lines: v.receipt.lines.map((/** @type {any} */ l) =>
        line({
          productCode: l.code,
          uom: l.uomCode,
          quantityBase: l.quantityBase,
          unitPriceCentavos: Number(l.unitPriceMinor),
          taxCode: l.taxCode,
          taxBasisPoints: l.taxBasisPoints,
        }),
      ),
      facts: {
        tripId: trip.id,
        saleId: v.sale_id,
        reason: v.reason,
        approvalId: v.approval_id,
        originalReceipt: v.receipt,
        instruction:
          "Reverse the original invoice under independent void approval",
      },
    },
  });
}
/** @param {any} db @param {any} trip @param {any} captured */
export async function enqueueVanSettlement(db, trip, captured) {
  const sales =
    await db`select id,receipt_number,total_centavos,sap_document_number from van_sales where trip_id=${trip.id} order by created_at,id`;
  const payments =
    await db`select id,kind,method,amount_centavos,sap_document_number from van_payments where trip_id=${trip.id} order by created_at,id`;
  const cash = await db`select * from van_cash_counts where trip_id=${trip.id}`;
  const stock =
    await db`select * from van_stock_counts where trip_id=${trip.id}`;
  const voids = await db`select * from van_sale_voids where trip_id=${trip.id}`;
  const returns = await db`select * from van_returns where trip_id=${trip.id}`;
  const parents =
    await db`select event_id from integration_events where event_type<>'settlement' and (payload->'document'->'facts'->>'tripId'=${trip.id}::text or source_type='movement' and movement_id in(select id from inventory_movements where source_type='van_trip' and source_document_id=${trip.id}))`;
  return enqueueSapPosting(db, {
    kind: "settlement",
    dependsOn: parents.map((/** @type {any} */ p) => p.event_id),
    sourceType: "van_trip",
    sourceId: trip.id,
    orgUnitId: trip.org_unit_id,
    document: {
      sourceType: "van_trip",
      sourceId: trip.id,
      customerCode: null,
      currency: "PHP",
      amountCentavos: null,
      occurredAt: captured.deviceTime ?? Date.now(),
      lines: [],
      facts: {
        tripId: trip.id,
        tripNumber: trip.trip_number,
        voids,
        returns,
        valuationMode: "sap_derive",
        sales,
        payments,
        cash,
        stock,
        captured,
      },
    },
  });
}
