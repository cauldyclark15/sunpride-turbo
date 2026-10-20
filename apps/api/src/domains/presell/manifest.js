/** F-303: isolated printable source-authorized driver document, not the office shell.
 * @param {unknown} value */
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      /** @type {Record<string,string>} */ ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
/** @param {any} data */
export function manifestHtml(data) {
  const body = data.rows
    .map(
      (/** @type {any} */ row) =>
        `<article><h2>${escape(row.sequence)}. ${escape(row.store)}</h2><p>${escape(row.address)}</p><p>Order ${escape(row.order)} · Confirmed ${escape(row.deliveryDate)}</p><p>${row.windowStart ? `Receiving: ${escape(new Date(row.windowStart).toLocaleString("en-PH", { timeZone: "Asia/Manila" }))} – ${escape(new Date(row.windowEnd).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" }))}` : "No receiving appointment"} · ${escape(row.bookingReference ?? "")}</p><table><thead><tr><th>Product</th><th>Allocated quantity</th><th>Base pieces</th></tr></thead><tbody>${row.lines.map((/** @type {any} */ l) => `<tr><td>${escape(l.description)}<small>${escape(l.product_code)}</small></td><td>${escape(l.ordered_quantity)} ${escape(l.uom)}</td><td>${escape(l.expected_base)}</td></tr>`).join("")}</tbody></table><p>Receiver signature: ________________________ &nbsp; Arrival: __________</p></article>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(data.label)} — driver manifest</title><style>body{font:14px system-ui,sans-serif;max-width:900px;margin:32px auto;color:#111;padding:16px}h1{font-size:24px}h2{font-size:18px}article{border-top:1px solid #aaa;padding:20px 0;break-inside:avoid}table{border-collapse:collapse;width:100%;text-align:left}td,th{padding:8px;border-bottom:1px solid #ddd}small{display:block;color:#666}button{padding:10px 16px;border:1px solid #aaa;background:white;border-radius:8px}@page{size:A4;margin:14mm}@media print{body{margin:0;padding:0;max-width:none}button{display:none}}</style></head><body><button onclick="window.print()">Print driver manifest</button><h1>${escape(data.label)}</h1><p>${escape(data.serviceDate)} · ${escape(data.tripNumber)} · ${escape(data.status === "planning" ? "Planning copy — not released" : "Released driver manifest")}</p><p>Truck ${escape(data.truck)} · Driver ${escape(data.driver)}</p>${body}</body></html>`;
}
