import { ApiError } from "../../core/errors.js";
import { originalDocument } from "./documents.js";
import { date, text, uuid } from "../orders/validation.js";
import { baseQuantity, resolvePrice } from "../orders/pricing.js";
import { createOrder, notify } from "../orders/service.js";
import { bindingAccess, officeRead } from "./hierarchy.js";
import { audit, command } from "./common.js";
import { parsePurchaseOrder } from "./parsers.js";

/** Revalidate against current authorized masters/prices on every preview/fix/confirmation.
 * @param {any} c @param {any} binding @param {any} input */
async function validate(c, binding, input) {
  const exceptions = [...(input.exceptions ?? [])];
  const poNumber =
    typeof input.poNumber === "string" ? input.poNumber.trim() : "";
  if (!poNumber || poNumber.length > 100)
    exceptions.push("Enter a PO number (up to 100 characters)");
  let serviceDate = null;
  try {
    serviceDate = date(input.serviceDate);
  } catch {
    exceptions.push("Enter a real delivery date");
  }
  const raw = Array.isArray(input.lines) ? input.lines : [];
  if (!raw.length || raw.length > 100)
    exceptions.push("Add 1–100 product lines");
  const seen = new Set(),
    lines = [];
  for (const l of raw.slice(0, 100)) {
    const errors = [];
    const code =
      typeof l.productCode === "string"
        ? l.productCode.trim().slice(0, 100)
        : "";
    const uom = typeof l.uom === "string" ? l.uom.trim().slice(0, 32) : "";
    const [product] =
      await c.db`select * from products where code=${code} and active and deleted_at is null and (organization_id is null or organization_id='sunpride')`;
    const qty =
      typeof l.quantity === "number" &&
      Number.isFinite(l.quantity) &&
      Math.abs(l.quantity) <= 1_000_000
        ? l.quantity
        : 0;
    if (!product) errors.push("Product is unknown or inactive");
    if (qty <= 0) errors.push("Quantity must be positive");
    if (seen.has(`${code}|${uom}`))
      errors.push("Duplicate product and selling unit");
    seen.add(`${code}|${uom}`);
    let price = null;
    if (product && qty > 0) {
      try {
        await baseQuantity(c.db, product, uom, qty, c.now);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        errors.push(e.message);
      }
      price = await resolvePrice(c.db, {
        organizationId: "sunpride",
        productId: product.id,
        uom,
        customerCode: binding.customer_code,
        outletId: binding.outlet_id,
        channelKey: null,
        at: c.now,
      });
      if (price.unitPriceCentavos === null)
        errors.push("Approved price needs setup");
    }
    const requested = l.requestedPriceCentavos;
    if (
      requested != null &&
      (!Number.isSafeInteger(requested) ||
        requested < 0 ||
        requested > 1_000_000_000_000)
    )
      errors.push("PO price must be whole centavos");
    if (
      requested != null &&
      price?.unitPriceCentavos != null &&
      requested !== price.unitPriceCentavos
    )
      errors.push("PO price differs from the approved price");
    lines.push({
      productCode: code,
      uom,
      quantity: qty,
      requestedPriceCentavos:
        Number.isSafeInteger(requested) &&
        requested >= 0 &&
        requested <= 1_000_000_000_000
          ? requested
          : null,
      productId: product?.id ?? null,
      exceptions: errors,
    });
  }
  return {
    poNumber,
    serviceDate,
    exceptions,
    lines,
    valid: !exceptions.length && lines.every((l) => !l.exceptions.length),
  };
}
/** @param {any} c @param {any} row */
async function view(c, row) {
  const binding = await bindingAccess(c, row.binding_id);
  const lines =
    await c.db`select product_code as "productCode",uom,quantity::float8 as quantity,requested_price_centavos::float8 as "requestedPriceCentavos",exceptions from mt_po_lines where intake_id=${row.id} order by ordinal`;
  return { ...row, branchLabel: binding.label, lines };
}
/** @param {any} c @param {string} id @param {string} [cap] */
async function intake(c, id, cap = "order.encode") {
  const [row] =
    await c.db`select * from inbound_purchase_orders where id=${uuid(id)}`;
  if (!row) throw new ApiError("not_found", 404, "Purchase order not found");
  const binding = await bindingAccess(c, row.binding_id, cap);
  return { row, binding };
}
/** @param {any} c @param {string} id @param {any} normalized */
async function saveLines(c, id, normalized) {
  await c.db`delete from mt_po_lines where intake_id=${id}`;
  for (const [i, l] of normalized.lines.entries())
    await c.db`insert into mt_po_lines(intake_id,ordinal,product_code,uom,quantity,requested_price_centavos,product_id,exceptions)
    values(${id},${i},${l.productCode},${l.uom},${l.quantity},${l.requestedPriceCentavos},${l.productId},${l.exceptions})`;
}
/** @param {any} router */
export function installIntake(router) {
  router.get("/api/v1/mt/intake", async (/** @type {any} */ c) => {
    await officeRead(c);
    const id = c.url.searchParams.get("id");
    if (id) return view(c, (await intake(c, id, "report.read")).row);
    const rows =
      await c.db`select * from inbound_purchase_orders order by created_at desc limit 501`;
    if (rows.length > 500)
      throw new ApiError(
        "capacity",
        422,
        "Narrow the intake archive before continuing",
      );
    const visible = [];
    for (const r of rows)
      try {
        visible.push(await view(c, r));
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
      }
    return { rows: visible };
  });
  router.get("/api/v1/mt/intake/document", async (/** @type {any} */ c) => {
    const { row } = await intake(
      c,
      c.url.searchParams.get("id"),
      "order.encode",
    );
    const [doc] =
      await c.db`select filename,format,sha256,content_base64 from mt_po_documents where id=${row.document_id}`;
    return doc;
  });
  router.post("/api/v1/mt/intake/preview", async (/** @type {any} */ c) => {
    const b = c.body ?? {};
    return command(
      c,
      "intake.preview",
      b,
      (cc) => bindingAccess(cc, b.bindingId, "order.encode"),
      async (cc) => {
        const binding = await bindingAccess(cc, b.bindingId, "order.encode");
        const format = text(b.format, "Format", 20);
        if (!["csv", "edi", "email", "ocr"].includes(format))
          throw new ApiError(
            "invalid_request",
            400,
            "Choose a supported document format",
          );
        const { filename, bytes, hash } = originalDocument(b);
        const [old] =
          await cc.db`select p.id from mt_po_documents d join inbound_purchase_orders p on p.document_id=d.id where d.binding_id=${binding.id} and d.sha256=${hash}`;
        if (old) return { id: old.id, duplicate: true };
        const [profile] =
          await cc.db`select columns from mt_intake_profiles where account_key=${binding.account_key} and format=${format} and effective_from<=now() and (effective_to is null or effective_to>now())`;
        let parsed;
        try {
          parsed = await parsePurchaseOrder(
            format,
            bytes,
            profile?.columns ?? {},
          );
        } catch (e) {
          if (!(e instanceof ApiError) && !(e instanceof TypeError)) throw e;
          parsed = {
            poNumber: "",
            serviceDate: "",
            lines: [],
            exceptions: [
              e instanceof ApiError ? e.message : "Document is not valid UTF-8",
            ],
          };
        }
        const data = await validate(cc, binding, parsed);
        const [doc] =
          await cc.db`insert into mt_po_documents(binding_id,filename,format,sha256,content_base64,created_by) values(${binding.id},${filename},${format},${hash},${b.contentBase64},${cc.user.id}) returning id`;
        const [po] =
          await cc.db`insert into inbound_purchase_orders(document_id,binding_id,po_number,service_date,exceptions,created_by) values(${doc.id},${binding.id},${data.poNumber},${data.serviceDate},${data.exceptions},${cc.user.id}) returning id`;
        await saveLines(cc, po.id, data);
        await audit(cc, "po.received", po.id);
        return { id: po.id, duplicate: false };
      },
    );
  });
  for (const action of ["fix", "confirm"])
    router.post(`/api/v1/mt/intake/${action}`, async (/** @type {any} */ c) => {
      const b = c.body ?? {};
      const result = await command(
        c,
        `intake.${action}`,
        b,
        (cc) => intake(cc, b.id),
        async (cc) => {
          const { row, binding } = await intake(cc, b.id);
          if (row.status !== "review")
            throw new ApiError("conflict", 409, "This PO is already confirmed");
          if (b.revision !== row.revision)
            throw new ApiError(
              "stale_revision",
              409,
              "This PO changed. Reload before continuing",
            );
          const old = await view(cc, row);
          if (
            action === "confirm" &&
            (old.exceptions.length ||
              old.lines.some((/** @type {any} */ l) => l.exceptions.length))
          )
            throw new ApiError(
              "validation_exceptions",
              422,
              "Save corrected lines and validate all exceptions before confirmation",
            );
          const input =
            action === "fix"
              ? b
              : {
                  poNumber: row.po_number,
                  serviceDate: row.service_date
                    ? new Date(row.service_date).toISOString().slice(0, 10)
                    : null,
                  lines: old.lines,
                  exceptions: row.exceptions,
                };
          const data = await validate(cc, binding, input);
          if (action === "fix") {
            await cc.db`update inbound_purchase_orders set po_number=${data.poNumber},service_date=${data.serviceDate},exceptions=${data.exceptions},revision=revision+1,updated_at=now() where id=${row.id}`;
            await saveLines(cc, row.id, data);
            await audit(cc, "po.corrected", row.id);
            return { id: row.id, revision: row.revision + 1 };
          }
          if (!data.valid)
            throw new ApiError(
              "validation_exceptions",
              422,
              "Fix all PO exceptions before confirmation",
            );
          // SAME commercial order object + approval + pricing + audit. No outside-call/planned-day restriction.
          const order = await createOrder(
            cc,
            {
              customerCode: binding.customer_code,
              outletId: binding.outlet_id,
              serviceDate: data.serviceDate,
              clientRequestId: `mt:${row.id}`,
              orderType: "modern_trade",
              lines: data.lines.map((l) => ({
                productId: l.productId,
                uom: l.uom,
                quantity: l.quantity,
              })),
            },
            { intake: true },
          );
          await cc.db`update inbound_purchase_orders set status='confirmed',po_identity=${binding.branch_key + "|" + data.poNumber.toLowerCase()},order_id=${order.id},confirmed_at=now(),revision=revision+1,updated_at=now() where id=${row.id}`;
          await audit(cc, "po.confirmed", row.id);
          return {
            id: row.id,
            orderId: order.id,
            orderNumber: order.order_number,
          };
        },
      );
      if (action === "confirm" && result.orderId) {
        const rows =
          await c.db`select org_unit_id,service_date from orders where id=${result.orderId}`;
        await notify(c, rows);
      }
      return result;
    });
}
