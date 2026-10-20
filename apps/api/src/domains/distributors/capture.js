import { ApiError } from "../../core/errors.js";
import {
  date,
  digest,
  fail,
  integer,
  list,
  location,
  master,
  outlet,
  product,
  text,
  today,
  uuid,
} from "./model.js";

export const SECONDARY_HEADERS = [
  "invoiceNumber",
  "lineKey",
  "revision",
  "date",
  "kind",
  "originalInvoiceNumber",
  "outletCode",
  "productCode",
  "locationCode",
  "batch",
  "uom",
  "quantity",
  "amountCentavos",
  "previousHash",
];
/** F-412: bounded RFC-4180 file adapter. No split(',') corruption of invoice names or quoted fields.
 * @param {string} input */
export function parseSecondaryCsv(input) {
  if (typeof input !== "string" || input.length > 700_000)
    fail("CSV must be under 700 KB");
  const rows = [];
  let row = [],
    cell = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else cell += ch;
    } else if (ch === '"') {
      if (cell || closed) fail("Malformed CSV quotes");
      quoted = true;
    } else if (ch === "," || ch === "\n" || ch === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (ch !== ",") {
        if (ch === "\r" && input[i + 1] === "\n") i++;
        rows.push(row);
        row = [];
      }
    } else {
      if (closed) fail("Unexpected text after CSV quote");
      cell += ch;
    }
    if (rows.length > 501) fail("Use at most 500 invoice lines per import");
  }
  if (quoted) fail("Unterminated CSV quote");
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const header = rows.shift();
  if (header?.[0]) header[0] = header[0].replace(/^\uFEFF/, "");
  if (JSON.stringify(header) !== JSON.stringify(SECONDARY_HEADERS))
    fail("Use the published secondary invoice CSV header, in order");
  return rows
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => {
      if (r.length !== SECONDARY_HEADERS.length)
        fail("CSV row has a different number of columns");
      /** @type {Record<string,any>} */ const v = Object.fromEntries(
        SECONDARY_HEADERS.map((h, i) => [h, r[i]]),
      );
      for (const k of ["revision", "quantity", "amountCentavos"])
        v[k] = Number(v[k]);
      return v;
    });
}
/** @param {any} c @param {any} d @param {any} b */
export async function declareStock(c, d, b) {
  const day = date(b.stockDate);
  if (day > today(c.now)) fail("Future stock declarations are not accepted");
  const rows = list(b.lines, 1000);
  if (!rows.length) fail("Declare stock, including zero balances");
  const [last] =
    await c.db`select * from distributor_stock_declarations where distributor_id=${d.id} and stock_date=${day} order by revision desc limit 1`;
  const revision = integer(b.revision, 1);
  if (revision !== Number(last?.revision ?? 0) + 1)
    fail(
      "Declare the next revision, retaining every prior snapshot",
      "version_conflict",
      409,
    );
  const active =
    await c.db`select id from distributor_locations where distributor_id=${d.id} and effective_from<=now() and (effective_to is null or effective_to>now())`;
  const seen = new Set(),
    used = new Set();
  const normalized = [];
  for (const row of rows) {
    const p = await product(c, d.id, uuid(row.productId));
    const l = await location(c, d.id, uuid(row.locationId));
    const batch = text(row.batch, "Batch", 100),
      quantity = integer(row.quantityBase, 0, 1_000_000_000),
      expiry = row.expiry ? date(row.expiry) : null;
    const key = `${p.productId}|${l.id}|${batch}`;
    if (seen.has(key)) fail("Duplicate product, location and batch");
    seen.add(key);
    used.add(l.id);
    normalized.push({
      productId: p.productId,
      locationId: l.id,
      batch,
      expiry,
      quantity,
      uom: p.uom,
    });
  }
  if (active.some((/** @type {any} */ l) => !used.has(l.id)))
    fail(
      "A complete declaration must include every warehouse and van (use zero balances)",
    );
  // Each catalog SKU at each location must be explicit; omission is unknown, not zero.
  const m = await master(c, d.id);
  for (const l of active)
    for (const p of m.payload.products)
      if (
        !normalized.some(
          (x) => x.locationId === l.id && x.productId === p.productId,
        )
      )
        fail("Include every catalog SKU at each location, even when zero");
  const [decl] =
    await c.db`insert into distributor_stock_declarations(distributor_id,stock_date,revision,request_key,payload_hash,source,submitted_by) values(${d.id},${day},${revision},${text(b.requestKey)},${digest(b)},${text(b.source ?? "portal")},${c.actor.profileId}) returning id`;
  for (const row of normalized)
    await c.db`insert into distributor_stock_lines(declaration_id,product_id,location_id,batch,expiry,uom,quantity_base) values(${decl.id},${row.productId},${row.locationId},${row.batch},${row.expiry},${row.uom},${row.quantity})`;
  return { id: decl.id, stockDate: day, revision, lines: normalized.length };
}
/** F-412 canonical mapping stays partner-scoped and effective-dated.
 * @param {any} c @param {any} d @param {any} b */
export async function setMap(c, d, b) {
  const kind = text(b.kind),
    code = text(b.externalCode),
    id = uuid(b.entityId);
  if (kind === "product") await product(c, d.id, id);
  else if (kind === "outlet") await outlet(c, d.id, id);
  else if (kind === "location") await location(c, d.id, id);
  else fail("Map product, outlet or location codes");
  await c.db`update distributor_code_maps set effective_to=now() where distributor_id=${d.id} and kind=${kind} and external_code=${code} and effective_to is null`;
  const [m] =
    await c.db`insert into distributor_code_maps(distributor_id,kind,external_code,entity_id,effective_from) values(${d.id},${kind},${code},${id},now()) returning id`;
  return m;
}
/** @param {any} c @param {string} id @param {string} kind @param {string} code */
async function resolve(c, id, kind, code) {
  const [m] =
    await c.db`select entity_id from distributor_code_maps where distributor_id=${id} and kind=${kind} and external_code=${text(code)} and effective_from<=now() and (effective_to is null or effective_to>now())`;
  if (!m) fail(`Map ${kind} code: ${code}`, "mapping_required");
  return m.entity_id;
}
/** @param {any} c @param {any} d @param {any} b */
export async function stageSecondary(c, d, b) {
  const adapter = text(b.adapter),
    source = text(b.sourceKey),
    rows =
      adapter === "csv"
        ? parseSecondaryCsv(b.csv)
        : adapter === "canonical"
          ? list(b.rows)
          : adapter === "invoice_json"
            ? list(b.invoices, 100).flatMap((invoice) =>
                list(invoice.lines, 100).map((line) => ({
                  ...line,
                  invoiceNumber: invoice.number,
                  date: invoice.date,
                  outletCode: invoice.retailer,
                  kind: invoice.kind ?? "sale",
                })),
              )
            : fail("Choose csv, canonical or invoice_json");
  const complete = b.complete === true,
    periodFrom = complete ? date(b.from) : "",
    periodTo = complete ? date(b.to) : "";
  if (
    complete &&
    (periodFrom > periodTo ||
      periodTo > today(c.now) ||
      Date.parse(periodTo) - Date.parse(periodFrom) > 365 * 86400000)
  )
    fail("Choose a complete-feed period of at most 366 past days");
  if ((!rows.length && !complete) || rows.length > 500)
    fail(
      "Import up to 500 lines, or explicitly declare a complete zero-sales period",
    );
  if (
    complete &&
    rows.some((r) => date(r.date) < periodFrom || date(r.date) > periodTo)
  )
    fail("Invoice dates fall outside the complete feed period");
  const hash = digest({ rows, complete, periodFrom, periodTo });
  const [old] =
    await c.db`select * from distributor_ingest_runs where distributor_id=${d.id} and source_key=${source}`;
  if (old) {
    if (old.payload_hash !== hash)
      fail(
        "Source key reused with different file content",
        "idempotency_conflict",
        409,
      );
    return { id: old.id, duplicate: true };
  }
  const [run] =
    await c.db`insert into distributor_ingest_runs(distributor_id,source_key,payload_hash,adapter,submitted_by,complete,period_from,period_to) values(${d.id},${source},${hash},${adapter},${c.actor.profileId},${complete},${complete ? periodFrom : null},${complete ? periodTo : null}) returning id`;
  for (const [i, row] of rows.entries())
    await c.db`insert into distributor_staging_lines(run_id,ordinal,raw) values(${run.id},${i},${row})`;
  return { id: run.id, lines: rows.length };
}
/** F-406: exact outlet and versioned invoice-line grain. All adapters/DSR converge here.
 * @param {any} c @param {any} d @param {any} b */
export async function processSecondary(c, d, b) {
  const [run] =
    await c.db`select * from distributor_ingest_runs where id=${uuid(b.runId)} and distributor_id=${d.id}`;
  if (!run) fail("Import not found in your distributor", "out_of_scope", 403);
  const rows =
    await c.db`select * from distributor_staging_lines where run_id=${run.id} order by ordinal`;
  const counts = { posted: 0, duplicate: 0, mapping: 0, rejected: 0 };
  for (const row of rows) {
    if (["posted", "duplicate"].includes(row.status)) {
      counts[/** @type {'posted'|'duplicate'} */ (row.status)]++;
      continue;
    }
    try {
      const r = row.raw;
      const invoice = text(r.invoiceNumber),
        lineKey = text(r.lineKey),
        revision = integer(r.revision, 1),
        day = date(r.date),
        kind = text(r.kind);
      if (day > today(c.now) || !["sale", "return"].includes(kind))
        fail("Check transaction date and sale/return kind");
      const sourceHash = digest(r);
      const [prior] =
        await c.db`select * from distributor_secondary_lines where distributor_id=${d.id} and invoice_number=${invoice} and line_key=${lineKey} order by revision desc limit 1`;
      if (
        prior &&
        Number(prior.revision) === revision &&
        prior.source_payload_hash === sourceHash
      ) {
        counts.duplicate++;
        await c.db`update distributor_staging_lines set status='duplicate',reason=null,fact_id=${prior.id},updated_at=now() where id=${row.id}`;
        continue;
      }
      const productId = await resolve(c, d.id, "product", r.productCode),
        outletId = await resolve(c, d.id, "outlet", r.outletCode),
        locationId = await resolve(c, d.id, "location", r.locationCode);
      const p = await product(c, d.id, productId);
      if (kind === "return") {
        const originals =
          await c.db`select distinct uom,units_per_uom from distributor_secondary_current where distributor_id=${d.id} and invoice_number=${text(r.originalInvoiceNumber, "Original invoice")} and outlet_id=${outletId} and product_id=${productId} and kind='sale'`;
        if (
          originals.length !== 1 ||
          originals[0].uom !== r.uom ||
          !originals[0].units_per_uom
        )
          fail("Original sale pack facts are missing or ambiguous");
        p.uom = originals[0].uom;
        p.unitsPerUom = Number(originals[0].units_per_uom);
      }
      await outlet(c, d.id, outletId);
      await location(c, d.id, locationId);
      if (r.uom !== p.uom) fail("UOM must match the assigned catalog unit");
      const quantity = integer(r.quantity, 1, 1_000_000),
        quantityBase = integer(
          quantity * integer(p.unitsPerUom, 1),
          1,
          1_000_000_000,
        ),
        amount = integer(r.amountCentavos),
        batch = text(r.batch);
      const original =
        kind === "return"
          ? text(r.originalInvoiceNumber, "Original invoice")
          : null;
      const facts = {
        invoice,
        lineKey,
        revision,
        day,
        kind,
        original,
        outletId,
        productId,
        locationId,
        batch,
        uom: r.uom,
        quantityBase,
        amount,
      };
      const hash = digest(facts);
      let id;
      if (
        prior &&
        Number(prior.revision) === revision &&
        prior.payload_hash === hash
      ) {
        id = prior.id;
        counts.duplicate++;
        await c.db`update distributor_staging_lines set status='duplicate',reason=null,fact_id=${id},updated_at=now() where id=${row.id}`;
        continue;
      }
      if (
        prior
          ? revision !== Number(prior.revision) + 1 ||
            r.previousHash !== prior.payload_hash
          : revision !== 1
      )
        fail(
          "Invoice revision conflicts; provide the prior content hash",
          "revision_conflict",
        );
      if (original) {
        const [sold] =
          await c.db`select coalesce(sum(quantity_base),0)::text as n from distributor_secondary_current where distributor_id=${d.id} and invoice_number=${original} and outlet_id=${outletId} and product_id=${productId} and kind='sale'`;
        const [returned] =
          await c.db`select coalesce(sum(quantity_base),0)::text as n from distributor_secondary_current where distributor_id=${d.id} and original_invoice_number=${original} and outlet_id=${outletId} and product_id=${productId} and kind='return' and (${prior?.id ?? null}::uuid is null or id<>${prior?.id ?? null}::uuid)`;
        if (Number(sold.n) < quantityBase + Number(returned.n))
          fail("Return exceeds matching original retailer sale");
      }
      if (prior?.kind === "sale") {
        const [returned] =
          await c.db`select coalesce(sum(quantity_base),0)::text as n from distributor_secondary_current where distributor_id=${d.id} and original_invoice_number=${prior.invoice_number} and outlet_id=${prior.outlet_id} and product_id=${prior.product_id} and kind='return'`;
        const [siblings] =
          await c.db`select coalesce(sum(quantity_base),0)::text as n from distributor_secondary_current where distributor_id=${d.id} and invoice_number=${prior.invoice_number} and outlet_id=${prior.outlet_id} and product_id=${prior.product_id} and kind='sale' and id<>${prior.id}`;
        const replacement =
          kind === "sale" &&
          outletId === prior.outlet_id &&
          productId === prior.product_id
            ? quantityBase
            : 0;
        if (Number(returned.n) > Number(siblings.n) + replacement)
          fail("Correction would orphan or exceed recorded returns");
      }
      const [fact] =
        await c.db`insert into distributor_secondary_lines(distributor_id,invoice_number,line_key,revision,source_key,payload_hash,sale_date,kind,original_invoice_number,outlet_id,product_id,location_id,batch,uom,quantity_base,amount_centavos,supersedes_id,source_payload_hash,quantity_units,units_per_uom) values(${d.id},${invoice},${lineKey},${revision},${run.source_key},${hash},${day},${kind},${original},${outletId},${productId},${locationId},${batch},${r.uom},${quantityBase},${amount},${prior?.id ?? null},${sourceHash},${quantity},${p.unitsPerUom}) returning id`;
      id = fact.id;
      counts.posted++;
      await c.db`update distributor_staging_lines set status='posted',reason=null,fact_id=${id},updated_at=now() where id=${row.id}`;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const status = e.code === "mapping_required" ? "mapping" : "rejected";
      counts[status]++;
      await c.db`update distributor_staging_lines set status=${status},reason=${e.message},updated_at=now() where id=${row.id}`;
    }
  }
  return { id: run.id, ...counts };
}
