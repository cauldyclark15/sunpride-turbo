import { requireCapability } from "../../core/capabilities.js";
import { invalid } from "../../core/errors.js";
import { uuid } from "../org/model.js";
import { locationFor, tripFor } from "../van/access.js";
import { productFor, frozenProduct } from "../van/facts.js";
import { resolvePrice } from "../orders/pricing.js";
import { extend } from "../van/model.js";

/** Persist the request's plan, vehicle, units and governed prices, never a product-master price.
 * @param {any} c @param {any} b @param {string} start @param {any} seller @param {any[]} lines */
export async function requestFacts(c, b, start, seller, lines) {
  const at = Date.parse(`${start}T00:00:00+08:00`);
  const plans =
    await c.db`select id,version,content_hash,effective_from,coalesce(active_through,effective_to) as until from coverage_plans
    where assignee_profile_id=${seller.id} and org_unit_id=${seller.org_unit_id} and status in ('approved','active','superseded')
    and approval_signature is not null and content_hash is not null and deleted_at is null
    and effective_from<${new Date(at + 6 * 86400000)} and coalesce(active_through,effective_to)>${new Date(at)} order by effective_from,id limit 501 for share`;
  if (plans.length > 500)
    throw invalid("Too many coverage plans for this week.");
  for (let i = 0; i < 6; i++) {
    const day = at + i * 86400000;
    if (
      !plans.some(
        (/** @type {any} */ p) =>
          +new Date(p.effective_from) <= day && +new Date(p.until) > day,
      )
    )
      throw invalid(
        "Approve the salesman's coverage plan for the whole Monday–Saturday week before preparing the stock request.",
      );
  }
  const [vehicle] =
    await c.db`select * from vehicles where id=${uuid(b.vehicleId)} and status='active' and deleted_at is null for share`;
  if (!vehicle) throw invalid("Choose an active vehicle.");
  await requireCapability(c, "van.manage", vehicle.org_unit_id);
  const depot = await locationFor(
    c.db,
    c.actor,
    vehicle.home_location_id,
    "van.manage",
  );
  const truck = await locationFor(
    c.db,
    c.actor,
    vehicle.truck_location_id,
    "van.manage",
  );
  if (
    depot.type === "truck" ||
    truck.type !== "truck" ||
    depot.organization_id !== vehicle.organization_id ||
    truck.organization_id !== vehicle.organization_id
  )
    throw invalid(
      "Choose a vehicle with a truck and issuing depot in the same organization.",
    );
  if (
    !Array.isArray(b.tripIds) ||
    b.tripIds.length > 50 ||
    new Set(b.tripIds).size !== b.tripIds.length
  )
    throw invalid("Choose up to 50 distinct trips for this stock week.");
  const trips = [];
  for (const id of [...b.tripIds].sort()) {
    const trip = await tripFor(c.db, c.actor, uuid(id), "van.manage", true);
    const day = String(
      trip.service_date instanceof Date
        ? trip.service_date.toISOString()
        : trip.service_date,
    ).slice(0, 10);
    if (
      trip.salesperson_profile_id !== seller.id ||
      trip.vehicle_id !== vehicle.id ||
      trip.source_location_id !== depot.id ||
      trip.status === "cancelled" ||
      trip.deleted_at ||
      day < start ||
      Date.parse(day) >= Date.parse(start) + 6 * 86400000
    )
      throw invalid(
        "Use this salesman's trips for Monday–Saturday, on the chosen truck and from its issuing depot.",
      );
    trips.push({ id: trip.id, number: trip.trip_number });
  }
  const channel =
    b.priceChannel == null || b.priceChannel === ""
      ? null
      : String(b.priceChannel).trim();
  if (channel && channel.length > 120)
    throw invalid("Choose a configured pricing channel.");
  const products = [];
  for (const l of lines) {
    const p = await productFor(c.db, l.productId);
    if (p.organization_id !== vehicle.organization_id)
      throw invalid("Use products in the vehicle's organization.");
    const price = await resolvePrice(c.db, {
      organizationId: vehicle.organization_id,
      productId: p.id,
      uom: p.base_code,
      channelKey: channel,
      customerCode: null,
      at,
    });
    products.push({
      ...frozenProduct(p),
      requestedBase: l.requestedBase,
      unitPriceMinor:
        price.unitPriceCentavos === null
          ? null
          : String(price.unitPriceCentavos),
      priceSource: price.source,
      priceKey: price.sapKey ?? null,
      priceVersion: price.sapVersion ?? null,
    });
  }
  return {
    plans: plans.map((/** @type {any} */ p) => ({
      id: p.id,
      version: p.version,
      hash: p.content_hash,
    })),
    vehicleId: vehicle.id,
    vehicle: vehicle.vehicle_code,
    plate: vehicle.plate_number,
    depotId: depot.id,
    depot: depot.name,
    truckLocationId: truck.id,
    priceChannel: channel,
    sapOrderReference:
      typeof b.sapOrderReference === "string"
        ? b.sapOrderReference.trim().slice(0, 100)
        : "",
    seller: seller.name,
    products: products.sort((a, b) => a.productId.localeCompare(b.productId)),
    trips,
  };
}

/** Missing prices/counts and negative accountability stay unknown, never partial or zero totals.
 * @param {any} week @param {any[]} lines */
export function cashierFacts(week, lines) {
  const priced = lines.map((l) => {
    const f = week.request_facts?.products?.find(
      (/** @type {any} */ p) => p.productId === l.productId,
    );
    const quantity =
      l.countedBase === null ? null : l.servedBase - l.countedBase;
    const price = f?.unitPriceMinor ?? null;
    const amount =
      quantity === null || quantity < 0 || price === null
        ? null
        : String(
            extend(BigInt(price), BigInt(quantity), BigInt(f.quantityScale)),
          );
    return {
      ...l,
      quantityScale: f?.quantityScale ?? l.quantityScale ?? "1",
      unitPriceMinor: price,
      priceSource: f?.priceSource ?? "missing",
      accountableBase: quantity,
      accountableMinor: amount,
    };
  });
  return {
    lines: priced,
    amountMinor: priced.some((l) => l.accountableMinor === null)
      ? null
      : String(priced.reduce((n, l) => n + BigInt(l.accountableMinor), 0n)),
  };
}

/** @param {any} value */
const escape = (value) =>
  String(value ?? "—").replace(
    /[&<>"']/g,
    (s) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        s
      ] ?? s,
  );
/** @param {any} n */
const money = (n) =>
  n == null
    ? "Unavailable"
    : `PHP ${BigInt(n) / 100n}.${String(BigInt(n) % 100n).padStart(2, "0")}`;
/** Exact scaled integer display, no mixed-unit totals. @param {number|null} n @param {any} scale */
export function quantityText(n, scale = "1") {
  if (n === null) return "Not counted";
  return `${n} / ${scale}`;
}
/** Authorized persisted projection only. No scripts, external assets or interpolated markup.
 * @param {any} d @param {string} kind */
export function printReport(d, kind) {
  if (!["request", "loading", "count", "cashier"].includes(kind))
    throw invalid("Choose a stock report.");
  if (kind === "request" && !d.requestFacts)
    throw invalid(
      "Prepare this request against an approved coverage plan first.",
    );
  const title = {
    request: "Weekly stock request",
    loading: "Actual stock served",
    count: "Saturday count sheet",
    cashier: "Cashier stock reconciliation",
  }[kind];
  const f = d.requestFacts;
  const body = d.lines
    .map((/** @type {any} */ l) => {
      const q = (/** @type {number|null} */ n) =>
        escape(quantityText(n, l.quantityScale));
      return `<tr><td>${escape(l.code)}<br>${escape(l.name)}</td><td>${escape(l.uom)}<br>Scale ${escape(l.quantityScale)}</td><td>${q(l.requestedBase)}</td><td>${q(l.servedBase)}</td><td>${q(l.shortfallBase)}</td><td>${q(l.soldBase)}</td><td>${q(l.countedBase)}</td><td>${q(l.varianceBase)}</td><td>${escape(l.reasonName)}<br>${escape(l.note)}</td>${kind === "cashier" ? `<td>${q(l.accountableBase)}</td><td>${escape(money(l.unitPriceMinor))}</td><td>${escape(money(l.accountableMinor))}</td>` : ""}</tr>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:13px system-ui;margin:28px;color:#111}table{border-collapse:collapse;width:100%}td,th{padding:7px;border:1px solid #999;text-align:left}thead{display:table-header-group}tr{break-inside:avoid}p{line-height:1.5}.warning{border:2px solid #333;padding:10px}@page{size:landscape;margin:12mm}@media print{body{margin:0}}</style><h1>${escape(title)}</h1><p>${escape(d.seller)} · Week of ${escape(d.weekStart)} · ${escape(d.status)}<br>Truck: ${escape(f?.vehicle)} · ${escape(f?.plate)} · Issuing depot: ${escape(f?.depot)}<br>SAP sales order reference: ${escape(f?.sapOrderReference)}<br>Approved plan versions: ${escape(f?.plans?.map((/** @type {any} */ p) => p.version).join(", "))}<br>Included POS trips: ${escape(f?.trips?.map((/** @type {any} */ t) => t.number).join(", ") || "None linked")}</p><p class="warning">QUANTITY RECORD ONLY — this weekly sheet does not move stock into the van or return it to storage. ${d.status === "reviewed" ? "Closed copy; original report facts retained." : "Provisional; quantities can still change."}</p><p>Quantities are scaled base units: numerator / scale (for example 1250 / 1000 = 1.250 of the named unit). Do not add different products or units.</p><table><thead><tr><th>Product</th><th>Unit / scale</th><th>Requested</th><th>Served</th><th>Shortfall</th><th>Net POS quantity</th><th>Counted remainder</th><th>Difference</th><th>Reason / note</th>${kind === "cashier" ? "<th>To account for</th><th>Price per unit</th><th>Stock accountability value</th>" : ""}</tr></thead><tbody>${body}</tbody></table>${kind === "cashier" ? `<p>Basis: actually served minus counted remainder. Difference: served minus net POS quantity minus counted remainder. Pricing channel: ${escape(f?.priceChannel ?? "Base condition")} at the start of the week. Line amounts rounded half-up to centavos.</p><p>Stock accountability value: <strong>${escape(money(d.cashier.amountMinor))}</strong><br>POS invoices excluding voids: ${escape(money(d.pos?.invoicesMinor))}<br>POS recorded refunds: ${escape(money(d.pos?.refundsMinor))}</p><p>This stock value is not cash due or a receipt for money. Credit, discounts, customer refunds and remittances remain separate. Missing prices or a missing/extra-stock count prevent a complete amount; no partial total is certified. ${d.lines.some((/** @type {any} */ l) => l.priceSource === "sap_sample") ? "SAMPLE PRICES — not client pricing." : ""}</p>` : ""}<p>Counted: ${escape(d.countedAt ? new Date(d.countedAt).toISOString() : null)} · Checked: ${escape(d.reviewedAt ? new Date(d.reviewedAt).toISOString() : null)}<br>Office note: ${escape(d.reviewNote)}</p><p>Salesman ____________________ Warehouse ____________________ Cashier ____________________</p></html>`;
}
