import { callSnapshot } from "../availability/calls.js";
import { tx } from "@sunpride/db/client";
import { partnerContext, partnerStoreGrants } from "../partners/boundary.js";
import { releasesAt } from "../availability/masters.js";
import { agendaForPlans } from "../coverage/agenda.js";
import { workforceContext } from "../coverage/workforce-policies.js";
import { checkDayManifest } from "./manifest.js";
import { policyAt } from "../presell/promise.js";
import { outletRetail } from "../retail/index.js";
import {
  configurationsForApp,
  hasConfiguredFlowsForApp,
} from "../callflow/engine.js";
import { catalogueMetadata } from "../masters/catalogue.js";
import { inventoryRows, PHOTO_TYPES } from "./reference.js";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { resolvePrice } from "../orders/pricing.js";
import { nativeSchemeContext } from "../tpm/native-context.js";
import { masterId } from "../integration/replicas.js";
import { scopeFilterForActor } from "../org/scope.js";
import {
  ORGANIZATION,
  ZERO_UUID,
  DAY_MS,
  bounded,
  closeAt,
  dateOf,
  manilaDate,
  midnight,
  ms,
  outletInScope,
  rebootstrap,
  safeInt,
  serviceDate,
  uuid,
} from "./model.js";
import { customerMasterSummaries } from "../masters/customers.js";

/** @typedef {import('../../core/sync.js').ProjectionCtx} ProjectionCtx */

/** @param {any} ctx @param {string} profileId @param {string} date @param {{from?:string,includeOldOpen?:boolean,organizationId?:string}} [options] */
export async function authorizedOrders(ctx, profileId, date, options = {}) {
  const db = ctx.db;
  if (await partnerContext(db, ctx.actor)) return [];
  const { unitIds } = await scopeFilterForActor(db, ctx.actor);
  const units = unitIds?.length ? unitIds : [ZERO_UUID];
  // Customer membership alone is never authority: independently gate the source
  // person, stored source location and current customer/outlet owner.
  return bounded(
    await db`
    select o.*, round(o.total * 100)::bigint as amount_minor,
      (coalesce(o.offline_created_at,o.created_at) at time zone 'Asia/Manila')::date as order_date
    from orders o join profiles p on (o.salesperson_subject = p.auth_subject or o.salesperson_subject = p.user_id::text)
    left join employee_assignments assignment on assignment.profile_id=p.id and assignment.deleted_at is null
      and assignment.effective_from<=${new Date(ctx.now)} and (assignment.effective_to is null or assignment.effective_to>${new Date(ctx.now)})
    left join inventory_locations l on l.id=o.source_location_id
    where p.id=${profileId} and p.status='active' and p.deleted_at is null and o.deleted_at is null
      and o.organization_id=${options.organizationId ?? ORGANIZATION}
      and (${unitIds === null} or coalesce(assignment.org_unit_id,p.org_unit_id) in ${db(units)})
      and (o.source_location_id is null or (l.deleted_at is null and l.active and l.organization_id=${ORGANIZATION} and (${unitIds === null} or l.org_unit_id in ${db(units)})))
      and exists (
        select 1 from customers c join outlet_customer_links link on link.customer_id=c.id
        join outlets ot on ot.id=link.outlet_id
        left join outlet_assignments oa on oa.outlet_id=ot.id and oa.deleted_at is null
          and oa.effective_from <= ${new Date(ctx.now)} and (oa.effective_to is null or oa.effective_to > ${new Date(ctx.now)})
        left join territory_ownerships own on own.territory_id=oa.territory_id and own.deleted_at is null
          and own.effective_from <= ${new Date(ctx.now)} and (own.effective_to is null or own.effective_to > ${new Date(ctx.now)})
        where c.code=o.customer_code and c.deleted_at is null and ot.deleted_at is null and link.deleted_at is null
          and link.effective_from <= ${new Date(ctx.now)} and (link.effective_to is null or link.effective_to > ${new Date(ctx.now)})
          and (${unitIds === null} or coalesce(own.org_unit_id,ot.custodian_org_unit_id) in ${db(units)})
      )
      and (coalesce(o.offline_created_at,o.created_at) >= ${new Date(midnight(options.from ?? date.slice(0, 7) + "-01"))}
        or (${options.includeOldOpen === true} and o.status in ('submitted','pending_approval','approved','sent_to_sap','review_required')))
      and coalesce(o.offline_created_at,o.created_at) < ${new Date(midnight(date) + DAY_MS)}
      order by coalesce(o.offline_created_at,o.created_at),o.id limit 5001`,
    5000,
  );
}
/** @param {any} ctx @param {any} person @param {string} date */
async function salesData(ctx, person, date) {
  const rows = await authorizedOrders(ctx, person.id, date);
  const sales = rows.filter(
    (/** @type {any} */ r) =>
      !["draft", "rejected", "voided"].includes(r.status),
  );
  const today = sales.filter(
    (/** @type {any} */ r) => dateOf(r.order_date) === date,
  );
  const total = (/** @type {any[]} */ a) =>
    safeInt(a.reduce((n, r) => n + safeInt(r.amount_minor), 0));
  const targets =
    await ctx.db`select period,round(value * 100)::bigint as minor from sales_targets
    where profile_id=${person.id} and subject_kind='employee' and metric='sales_value' and deleted_at is null
      and effective_from<=${new Date(midnight(date) + 12 * 3_600_000)} and (effective_to is null or effective_to>${new Date(midnight(date) + 12 * 3_600_000)})`;
  const daily = targets.find((/** @type {any} */ t) => t.period === "daily");
  const monthly = targets.find(
    (/** @type {any} */ t) => t.period === "monthly",
  );
  const [standard] = await ctx.db`select s.* from position_standards s
    where s.position_id=${person.current_position_id ?? person.position_id ?? ZERO_UUID} and s.deleted_at is null
      and s.effective_from<=${new Date(ctx.now)} and (s.effective_to is null or s.effective_to>${new Date(ctx.now)}) limit 1`;
  const dailyMinor = daily ? safeInt(daily.minor) : null;
  return {
    serviceDate: date,
    targets: {
      daily: dailyMinor,
      monthly: monthly ? safeInt(monthly.minor) : null,
    },
    totals: {
      todaySales: total(today),
      todayPct: dailyMinor
        ? Math.round((total(today) / dailyMinor) * 100)
        : null,
      mtdSales: total(sales),
    },
    calls: { productiveCallRule: standard?.productive_call_rule ?? null },
  };
}
export { dayFacts } from "./field-day.js";
/** @param {ProjectionCtx} ctx */
async function suggestedOrder(ctx) {
  await requireCapability(ctx, "report.read");
  await outletInScope(ctx, ctx.params.outletId);
  if (ctx.actor.role === "sales") {
    const assigned =
      await ctx.db`select 1 from planned_visits where assignee_profile_id=${ctx.actor.profileId} and outlet_id=${ctx.params.outletId}
      and service_date=${ctx.params.asOfDate}::date and status='planned' and deleted_at is null limit 1`;
    if (!assigned.length)
      throw rebootstrap("This store is not in your signed day plan");
  }
  // No recommendation table exists in frozen schema 0114. Do not fabricate a
  // recommendation from sales totals. ANALYTICS can install this documented view.
  const [exists] =
    await ctx.db`select to_regclass('public.analytics_suggested_orders') as name`;
  let lines = [];
  if (exists.name) {
    const rows = bounded(
      await ctx.db`select product_id,code,name,unit,status,suggested_quantity,reasons
      from analytics_suggested_orders where outlet_id=${ctx.params.outletId} and as_of_date=${ctx.params.asOfDate}::date order by code limit 501`,
      500,
    );
    lines = rows.map((/** @type {any} */ r) => ({
      productId: r.product_id,
      code: r.code,
      name: r.name,
      unit: r.unit,
      status: r.status,
      suggestedQuantity:
        r.suggested_quantity === null ? null : safeInt(r.suggested_quantity),
      reasons: r.reasons,
    }));
  }
  // Existing provisional defaults: one-day lead time and a seven-day cycle.
  // With no analytics model these describe the horizon, NOT an invented order.
  return {
    data: {
      version: "suggested-order/v2",
      asOfDate: ctx.params.asOfDate,
      outlet: { outletId: ctx.params.outletId },
      coverDays: 8,
      nextVisit: { days: 7 },
      leadTimeDays: 1,
      leadTimeProvisional: true,
      historyStatus: exists.name ? "available" : "analytics_unavailable",
      lines,
    },
    next: null,
  };
}

/** @param {ProjectionCtx} ctx */
async function bundleData(ctx) {
  await requireCapability(ctx, "visit.record");
  if (ctx.app === "van-android")
    throw rebootstrap("Use the van bundle for this app");
  const date = ctx.params.dayFrom;
  if (date !== manilaDate(ctx.now))
    throw rebootstrap("Download the current Manila day");
  const db = ctx.db;
  const partner = await partnerContext(db, ctx.actor);
  const partnerGrants = partner ? await partnerStoreGrants(db, partner) : [];
  const permitted = new Set(
    partnerGrants.map((/** @type {any} */ r) => r.outlet_id),
  );
  const [person] =
    await db`select p.*,u.organization_id,coalesce(a.position_id,p.position_id) as current_position_id from profiles p
      left join employee_assignments a on a.profile_id=p.id and a.deleted_at is null
        and a.effective_from<=${new Date(ctx.now)} and (a.effective_to is null or a.effective_to>${new Date(ctx.now)})
      join org_units u on u.id=coalesce(a.org_unit_id,p.org_unit_id)
      where p.id=${ctx.actor.profileId} and p.status='active' and p.deleted_at is null and u.organization_id=${ORGANIZATION}`;
  if (!person) throw rebootstrap("Your field assignment is unavailable");
  const planned = bounded(
    await db`
    select pv.*,s.sequence from planned_visits pv join coverage_plans cp on cp.id=pv.plan_id
      join coverage_plan_slots s on s.id=pv.plan_slot_id
    where pv.assignee_profile_id=${person.id} and pv.service_date>=${date}::date and pv.service_date<${date}::date+3
      and pv.status='planned' and pv.deleted_at is null and cp.deleted_at is null and s.deleted_at is null
      and cp.status in ('approved','active') and cp.approval_signature is not null and cp.content_hash is not null
      and (${!partner} or pv.outlet_id in ${db(permitted.size ? [...permitted] : [ZERO_UUID])})
    order by pv.service_date,s.sequence,pv.id limit 501`,
    500,
  );
  const retailEnabled =
    ctx.app === "field-android" &&
    (await releasesAt(db, "msl", ctx.now)).length > 0;
  const retailContext = {
    ...ctx,
    availabilityHistory: new Map(),
    availabilityOutletIds: [
      ...new Set(planned.map((/** @type {any} */ p) => p.outlet_id)),
    ],
  };
  const outlets = new Map();
  const routeRows = new Map();
  for (const p of planned) {
    const s = p.approved_snapshot;
    if (!s || s.outletId !== p.outlet_id || typeof s.outletName !== "string")
      throw rebootstrap("A signed stop is incomplete");
    await outletInScope(ctx, p.outlet_id);
    const [currentOutlet] =
      await db`select address from outlets where id=${p.outlet_id} and deleted_at is null`;
    const pins =
      await db`select latitude,longitude from outlet_pins where outlet_id=${p.outlet_id} and status='verified' and deleted_at is null
      and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)}) limit 2`;
    const pin = pins.length === 1 ? pins[0] : null;
    outlets.set(p.outlet_id, {
      id: p.outlet_id,
      name: s.outletName,
      routeId: s.routeId ?? null,
      code: s.outletCode ?? null,
      customerId: s.customerId ?? null,
      address: currentOutlet?.address ?? null,
      latitude: pin?.latitude ?? null,
      longitude: pin?.longitude ?? null,
      territoryId: s.territoryId ?? null,
      territoryCode: s.territoryCode ?? null,
    });
    if (retailEnabled) {
      const cached = outlets.get(p.outlet_id);
      cached.availability = await callSnapshot(
        retailContext,
        p.outlet_id,
        date,
      );
    }
    if (s.routeId && s.routeCode)
      routeRows.set(s.routeId, { id: s.routeId, code: s.routeCode });
  }
  // F-205: cache the assigned territory universe, not only planned stops, for genuinely off-route calls.
  const flowEnabled = await hasConfiguredFlowsForApp(db, ctx.app, ctx.now);
  if (flowEnabled) {
    const extra = bounded(
      await db`select distinct o.id,o.name,o.code,o.address,a.route_id,a.territory_id,t.code as territory_code
      from outlets o join outlet_assignments a on a.outlet_id=o.id join territories t on t.id=a.territory_id
      join territory_salespeople s on s.territory_id=t.id join territory_ownerships own on own.territory_id=t.id
      where s.profile_id=${person.id} and own.org_unit_id=${ctx.actor.orgUnitId} and o.status='active' and t.status='active'
        and o.deleted_at is null and a.deleted_at is null and t.deleted_at is null and s.deleted_at is null and own.deleted_at is null
        and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now())
        and s.effective_from<=now() and (s.effective_to is null or s.effective_to>now())
        and own.effective_from<=now() and (own.effective_to is null or own.effective_to>now()) order by o.id limit 501`,
      500,
    );
    for (const o of extra.filter(
      (/** @type {any} */ r) => !partner || permitted.has(r.id),
    ))
      if (!outlets.has(o.id))
        outlets.set(o.id, {
          id: o.id,
          name: o.name,
          code: o.code,
          address: o.address,
          routeId: o.route_id,
          territoryId: o.territory_id,
          territoryCode: o.territory_code,
        });
  }
  // F-211/F-407: off-route shared outlets need the same canonical MSL, not a name-only roster.
  if (retailEnabled) {
    retailContext.availabilityOutletIds = [...outlets.keys()];
    for (const value of outlets.values())
      if (!value.availability)
        value.availability = await callSnapshot(retailContext, value.id, date);
  }
  // F-006: the exact definition/policy rides the existing encrypted outlet snapshot.
  if (flowEnabled && outlets.size) {
    const rows =
      await db`select id,classification,channel from outlets where id in ${db([...outlets.keys()])}`;
    const configs = await configurationsForApp(db, ctx.app, rows, ctx.now, {
      profileId: ctx.actor.profileId,
      deviceId: ctx.device.id,
    });
    for (const [id, value] of outlets)
      if (configs.has(id)) {
        value.callFlow = configs.get(id);
        if (value.callFlow.definition.channelProfile === "pre_sell")
          value.callFlow.deliveryPolicy = await policyAt(db, ctx.now);
        if (value.callFlow.definition.channelProfile === "merchandiser")
          value.callFlow.retail = await outletRetail(ctx, { ...value, id });
      }
  }
  // The store's own owner contact (Add store / approved Edit store / office edit): the phone shows it
  // and dials it ahead of the call-sheet header. Partners never receive it (as with buyer/contact).
  if (!partner && outlets.size) {
    const contacts =
      await db`select distinct on (outlet_id) outlet_id,name,phone from outlet_contacts
      where outlet_id in ${db([...outlets.keys()])} and deleted_at is null order by outlet_id,ordinal`;
    for (const c of contacts) {
      const value = outlets.get(c.outlet_id);
      if (!value) continue;
      if (typeof c.name === "string" && c.name.trim())
        value.ownerName = c.name.trim();
      if (typeof c.phone === "string" && c.phone.trim())
        value.ownerPhone = c.phone.trim();
    }
  }
  // SP-0170: the client's customer classification rides each outlet (additive keys only).
  for (const [id, summary] of await customerMasterSummaries(db, [
    ...outlets.keys(),
  ])) {
    const value = outlets.get(id);
    if (value) Object.assign(value, summary);
  }
  const agenda = await agendaForPlans(ctx, planned);
  const outletIds = [...outlets.keys()];
  const lookupIds = outletIds.length ? outletIds : [ZERO_UUID];
  const accounts = bounded(
    await db`select * from call_sheet_accounts where outlet_id in ${db(lookupIds)} and deleted_at is null order by outlet_id limit 501`,
    500,
  );
  const lines = bounded(
    await db`select l.*,a.outlet_id from call_sheet_account_lines l join call_sheet_accounts a on a.id=l.call_sheet_account_id
    where a.outlet_id in ${db(lookupIds)} and a.deleted_at is null and l.deleted_at is null order by a.outlet_id,l.ordinal limit 5001`,
    5000,
  );
  const assortment = bounded(
    await db`select ap.product_id,a.outlet_id from outlet_assortment_products ap join outlet_assortments a on a.id=ap.outlet_assortment_id
    where a.outlet_id in ${db(lookupIds)} and a.deleted_at is null and ap.deleted_at is null
      and a.effective_from<=${new Date(ctx.now)} and (a.effective_to is null or a.effective_to>${new Date(ctx.now)}) limit 5001`,
    5000,
  );
  // SEAM(MASTERS): the resolved published MSL/focus audience authorizes these
  // additional orderable SKUs without inventing a second product master.
  for (const outlet of outlets.values())
    if (outlet.availability?.lines?.length) {
      if (!accounts.some((/** @type {any} */ a) => a.outlet_id === outlet.id))
        accounts.push({
          outlet_id: outlet.id,
          revision: 1,
          header_account_name: outlet.name,
        });
      for (const l of outlet.availability.lines)
        if (
          !lines.some(
            (/** @type {any} */ a) =>
              a.outlet_id === outlet.id && a.product_id === l.productId,
          )
        )
          lines.push({
            outlet_id: outlet.id,
            product_id: l.productId,
            pricing: null,
          });
    }
  const productIds = [
    ...new Set(
      [...lines, ...assortment].map((/** @type {any} */ l) => l.product_id),
    ),
  ];
  const catalog = bounded(
    await db`select * from products where id in ${db(productIds.length ? productIds : [ZERO_UUID])} and active and deleted_at is null order by code limit 1001`,
    1000,
  );
  const products = [];
  for (const p of catalog) {
    const uoms = bounded(
      await db`select u.* from product_selling_uoms ps join units_of_measure u on u.id=ps.uom_id
      where ps.product_id=${p.id} and ps.deleted_at is null and u.deleted_at is null and u.active order by ps.ordinal limit 101`,
      100,
    );
    const [base] = p.base_uom_id
      ? await db`select * from units_of_measure where id=${p.base_uom_id} and deleted_at is null`
      : [];
    const sellingUoms = [];
    for (const u of uoms) {
      const conversions =
        await db`select * from uom_conversions where (product_id=${p.id} or product_id is null)
        and from_uom_id=${u.id} and to_uom_id=${p.base_uom_id} and active and deleted_at is null
        and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)}) order by product_id nulls last limit 3`;
      const c =
        conversions.find((/** @type {any} */ c) => c.product_id === p.id) ??
        conversions[0];
      sellingUoms.push({
        code: u.code,
        name: u.name,
        decimalPlaces: u.decimal_places,
        toBase:
          u.id === p.base_uom_id
            ? { numerator: 1, denominator: 1, roundingMode: "exact" }
            : c
              ? {
                  numerator: safeInt(c.numerator),
                  denominator: safeInt(c.denominator),
                  roundingMode: c.rounding_mode,
                }
              : null,
      });
    }
    const barcodes = bounded(
      await db`select b.barcode,u.code from product_barcodes b join units_of_measure u on u.id=b.uom_id
      where b.product_id=${p.id} and b.active and b.deleted_at is null and u.deleted_at is null order by b.barcode limit 501`,
      500,
    );
    const catalogue = await catalogueMetadata(db, p.id, ctx.now);
    products.push({
      ...(catalogue ? { catalogue } : {}),
      id: p.id,
      code: p.code,
      name: p.name,
      uom: p.uom,
      revision: safeInt(p.change_seq),
      quantityScale: safeInt(p.quantity_scale ?? 1),
      baseUom: base
        ? {
            code: base.code,
            name: base.name,
            decimalPlaces: base.decimal_places,
          }
        : null,
      sellingUoms,
      barcodes: barcodes.map((/** @type {any} */ b) => ({
        barcode: b.barcode,
        uom: b.code,
      })),
    });
  }
  const productMap = new Map(products.map((p) => [p.id, p]));
  const headerKeys = [
    "accountName",
    "address",
    "buyerName",
    "contactNumber",
    "accountInCharge",
    "receivingInCharge",
    "distributorName",
    "distributorSchedule",
    "foc",
    "pricing",
  ];
  const headerCols = [
    "header_account_name",
    "header_address",
    "header_buyer_name",
    "header_contact_number",
    "header_account_in_charge",
    "header_receiving_in_charge",
    "header_distributor_name",
    "header_distributor_schedule",
    "header_foc",
    "header_pricing",
  ];
  const callSheets = accounts.map((/** @type {any} */ a) => ({
    outletId: a.outlet_id,
    revision: a.revision,
    header: Object.fromEntries(
      headerKeys.map((k, i) => [k, a[headerCols[i]] ?? null]),
    ),
    lines: lines
      .filter(
        (/** @type {any} */ l) =>
          l.outlet_id === a.outlet_id && productMap.has(l.product_id),
      )
      .map((/** @type {any} */ l) => {
        const p = productMap.get(l.product_id);
        if (!p) throw rebootstrap();
        return {
          productId: p.id,
          code: p.code,
          name: p.name,
          uom: p.uom,
          barcode: p.barcodes[0]?.barcode ?? null,
          pricing: l.pricing ?? null,
        };
      }),
  }));
  if (partner)
    for (const sheet of callSheets) {
      sheet.header = Object.fromEntries(
        Object.entries(sheet.header).map(([k, v]) => [
          k,
          ["accountName", "address"].includes(k) ? v : null,
        ]),
      );
      for (const line of sheet.lines) line.pricing = null;
    }
  const orderTerms = [];
  const localCustomers = new Map();
  const summaries = [];
  const summaryFrom = manilaDate(midnight(date) - 90 * DAY_MS);
  const orders = await authorizedOrders(ctx, person.id, date, {
    from: summaryFrom,
    includeOldOpen: true,
  });
  for (const id of outletIds) {
    if (partner?.partner_kind === "agency") continue;
    const [customer] =
      await db`select c.*,round(c.credit_limit*100)::bigint as credit_minor from outlet_customer_links l join customers c on c.id=l.customer_id where l.outlet_id=${id}
      and l.deleted_at is null and c.deleted_at is null and l.effective_from<=${new Date(ctx.now)} and (l.effective_to is null or l.effective_to>${new Date(ctx.now)})`;
    if (customer)
      localCustomers.set(customer.id, { id: customer.id, code: customer.code });
    const priceLines = [],
      nativePrices = [],
      listIds = new Set();
    for (const productId of new Set(
      [...lines, ...assortment]
        .filter(
          (/** @type {any} */ l) =>
            l.outlet_id === id && productMap.has(l.product_id),
        )
        .map((/** @type {any} */ l) => l.product_id),
    )) {
      const p = productMap.get(productId);
      if (!p) throw rebootstrap();
      const sellingUnits = [
        ...new Set([p.uom, ...p.sellingUoms.map((u) => u.code)]),
      ];
      for (const uom of sellingUnits) {
        const price = await resolvePrice(db, {
          organizationId: person.organization_id,
          productId: p.id,
          uom,
          channelKey:
            outlets.get(id)?.channel ??
            customer?.channel ??
            person.channel_scope ??
            null,
          customerCode: customer?.code ?? null,
          outletId: id,
          at: ctx.now,
        });
        nativePrices.push({ productId: p.id, uom, ...price });
        if (price.priceListId) listIds.add(price.priceListId);
        priceLines.push({
          productId: p.id,
          uom,
          unitPriceMinor:
            price.unitPriceCentavos === null
              ? null
              : safeInt(price.unitPriceCentavos),
        });
      }
    }
    const listId = listIds.size === 1 ? [...listIds][0] : null;
    const [pl] = listId
      ? await db`select * from price_lists where id=${listId}`
      : [];
    orderTerms.push({
      outletId: id,
      priceList: pl
        ? {
            id: pl.id,
            code: pl.code,
            name: pl.name,
            currency: pl.currency,
            sample: pl.source === "sample",
          }
        : priceLines.some((p) => p.unitPriceMinor !== null)
          ? {
              id: masterId("field.priceQuote", id),
              code: "SAP-QUOTE",
              name: "SAP replicated conditions",
              currency: "PHP",
              sample: nativePrices.some((p) => p.source === "sap_sample"),
            }
          : null,
      lines: priceLines,
      ...(ctx.params.schemeEngine === 1
        ? {
            schemes: await nativeSchemeContext(
              { ...ctx, db },
              {
                outletId: id,
                channelKey:
                  outlets.get(id)?.channel ?? customer?.channel ?? null,
                products: priceLines.map((p) => ({
                  productId: p.productId,
                  uom: p.uom,
                  name: productMap.get(p.productId)?.name,
                  code: productMap.get(p.productId)?.code,
                })),
                prices: nativePrices,
              },
            ),
          }
        : {}),
    });
    if (partner) continue; // No accounting/AR history is granted to external field staff.
    const links = customer
      ? await db`select outlet_id from outlet_customer_links where customer_id=${customer.id} and deleted_at is null
      and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)}) order by outlet_id limit 21`
      : [];
    const canSummarize =
      Boolean(customer) &&
      links.length <= 20 &&
      links.every((/** @type {any} */ l) => outlets.has(l.outlet_id));
    const accountOrders = orders.filter(
      (/** @type {any} */ o) => o.customer_code === customer?.code,
    );
    const sold = accountOrders.filter(
      (/** @type {any} */ o) =>
        !["draft", "rejected", "voided"].includes(o.status) &&
        dateOf(o.order_date) >= summaryFrom,
    );
    const recent = sold.filter(
      (/** @type {any} */ o) =>
        midnight(dateOf(o.order_date)) >= midnight(date) - 27 * DAY_MS,
    );
    const open = accountOrders.filter((/** @type {any} */ o) =>
      [
        "submitted",
        "pending_approval",
        "approved",
        "sent_to_sap",
        "review_required",
      ].includes(o.status),
    );
    const sum = (/** @type {any[]} */ rs) =>
      safeInt(rs.reduce((s, r) => s + safeInt(r.amount_minor), 0));
    const last = sold
      .filter((/** @type {any} */ o) => safeInt(o.amount_minor) > 0)
      .at(-1);
    summaries.push({
      outletId: id,
      asOfDate: date,
      availability: canSummarize ? "available" : "withheld",
      creditLimitMinor: canSummarize ? safeInt(customer.credit_minor) : null,
      sales: canSummarize
        ? {
            from: summaryFrom,
            to: date,
            complete: true,
            orders: sold.length,
            amountMinor: sum(sold),
            recentOrders: recent.length,
            recentAmountMinor: sum(recent),
            lastOrderDate: last ? dateOf(last.order_date) : null,
            lastOrderAmountMinor: last ? safeInt(last.amount_minor) : null,
          }
        : null,
      openOrders: canSummarize
        ? { count: open.length, amountMinor: sum(open) }
        : null,
    });
  }
  const rules = bounded(
    await db`select * from visit_activity_rules where organization_id=${person.organization_id} and deleted_at is null
    and effective_from<=${new Date(ctx.now)} and (effective_to is null or effective_to>${new Date(ctx.now)}) order by intent limit 101`,
    100,
  );
  const activityRules = [];
  for (const r of rules) {
    const activities = bounded(
      await db`select kind,required from visit_activity_rule_activities where visit_activity_rule_id=${r.id} and deleted_at is null order by ordinal limit 101`,
      100,
    );
    activityRules.push({
      intent: r.intent,
      version: String(r.change_seq),
      activities: activities.map((/** @type {any} */ a) => ({
        kind: a.kind,
        required: a.required,
      })),
    });
  }
  const tasks = bounded(
    await db`select * from field_tasks where assignee_profile_id=${person.id} and status='open' and deleted_at is null
    and effective_from<${new Date(midnight(date) + 3 * DAY_MS)} and (effective_to is null or effective_to>${new Date(midnight(date))}) order by id limit 501`,
    500,
  );
  const [standard] = await db`select s.* from position_standards s
    where s.position_id=${person.current_position_id ?? person.position_id ?? ZERO_UUID} and s.deleted_at is null
      and s.effective_from<=${new Date(ctx.now)} and (s.effective_to is null or s.effective_to>${new Date(ctx.now)}) limit 1`;
  const sales = await salesData(ctx, person, date);
  const soldToday = orders.filter(
    (/** @type {any} */ o) =>
      dateOf(o.order_date) === date &&
      !["draft", "rejected", "voided"].includes(o.status),
  );
  const inventoryAvailability = partner ? [] : await inventoryRows(ctx);
  // This person's own recorded calls in the bundle window, in the same shape as the `visit` delta value,
  // so a phone that bootstraps mid-day (new phone, reinstall, sign-out/in) knows which stops are done.
  const visitExecutions = bounded(
    await db`select id,outlet_id,service_date,state,productivity,planned_visit_id from visit_executions
      where assignee_profile_id=${person.id} and service_date>=${date}::date and service_date<${date}::date+3
      and deleted_at is null order by service_date,created_at,id limit 201`,
    200,
  ).filter((/** @type {any} */ r) =>
    partner
      ? permitted.has(r.outlet_id)
      : outlets.has(r.outlet_id) || r.planned_visit_id,
  );
  const lease = Math.min(
    closeAt(date),
    ...[
      partner?.effective_to,
      partner?.partner_until,
      ...partnerGrants.map((/** @type {any} */ g) => g.effective_to),
    ]
      .filter(Boolean)
      .map((t) => new Date(t).getTime()),
  );
  // F-209/F-222: independently authorized non-call forms can have a different day window.
  // Only a negotiated new client gets this cache grant; its visit lease remains unchanged.
  const workforce =
    ctx.params.includeWorkforce === true
      ? await workforceContext(ctx.db, person.id, ctx.now)
      : null;
  const cacheLease =
    ctx.params.includeWorkforce === true ? midnight(date) + DAY_MS : lease;
  return {
    permissions: partner
      ? ["visit.record", "visit.read", "outlet.read", "mcp.read"]
      : [...ctx.actor.capabilities],
    employee: {
      id: person.id,
      // NF-4: the phone burns this name into every visit photo (F-312 watermark); without it no photo saves.
      name: person.name,
      role: ctx.actor.role,
      orgUnitId: ctx.actor.orgUnitId,
      ...(workforce ? { workforce } : {}),
    },
    scope: {
      fingerprint: ctx.scope.fingerprint,
      orgUnitIds: ctx.scope.orgUnitIds,
    },
    appConfig: {
      offlineLeaseExpiresAt: lease,
      cacheExpiresAt: cacheLease,
      orderCaptureEnabled: false,
      priceAvailability: "unavailable",
      promotionsAvailability: "unavailable",
    },
    plannedVisits: planned.map((/** @type {any} */ p) => ({
      id: p.id,
      outletId: p.outlet_id,
      serviceDate: dateOf(p.service_date),
      planId: p.plan_id,
      planVersion: p.plan_version,
      intents: p.intents,
      sequence: p.sequence,
      requiredObjectives: p.required_objectives ?? [],
      agenda: {
        ...agenda.get(`${p.outlet_id}:${dateOf(p.service_date)}`),
        objectives: p.required_objectives ?? [],
      },
    })),
    outlets: [...outlets.values()],
    localCustomers: [...localCustomers.values()],
    route: routeRows.size === 1 ? [...routeRows.values()][0] : null,
    tasks: tasks
      .filter((/** @type {any} */ t) => !partner || permitted.has(t.outlet_id))
      .map((/** @type {any} */ t) => ({
        id: t.id,
        kind: t.kind,
        required: t.required,
      })),
    productCatalog: products,
    inventoryAvailability,
    callSheets,
    orderTerms,
    accountSummaries: summaries,
    activityRules,
    photoTypes: [...PHOTO_TYPES],
    visitExecutions: visitExecutions.map((/** @type {any} */ r) => ({
      id: r.id,
      outletId: r.outlet_id,
      serviceDate: dateOf(r.service_date),
      state: r.state,
      productivity: r.productivity,
      plannedVisitId: r.planned_visit_id ?? null,
    })),
    dayTarget: standard
      ? {
          dailyCalls: standard.daily_calls_target,
          productivePct: standard.productive_call_target_pct,
          sourceRef: standard.source_ref,
          productiveCallRule: standard.productive_call_rule,
        }
      : null,
    daySales: {
      amountMinor: sales.totals.todaySales,
      orders: soldToday.length,
      targetMinor: sales.targets.daily,
    },
  };
}
/** @param {ProjectionCtx} ctx */
async function fieldSnapshot(ctx) {
  await requireCapability(ctx, "visit.record");
  if (ctx.app === "van-android" || ctx.params.dayFrom !== manilaDate(ctx.now))
    throw rebootstrap();
  await checkDayManifest(ctx);
  return tx(ctx.db, async (db) => {
    await db`set transaction isolation level repeatable read`;
    const data = await bundleData({ ...ctx, db });
    const {
      accountSummaries: _summaries,
      daySales: _sales,
      ...staticData
    } = data;
    const hash = sha256Hex(canonicalJson(staticData));
    if (ctx.state && ctx.state.hash !== hash) throw rebootstrap();
    const offset = ctx.state?.offset ?? 0;
    let more = false;
    for (const [key, value] of Object.entries(data))
      if (Array.isArray(value) && key !== "permissions") {
        more ||= value.length > offset + ctx.limit;
        // Every page is the same closed DTO, not a loose row envelope.
        /** @type {any} */ (data)[key] = value.slice(
          offset,
          offset + ctx.limit,
        );
      }
    return { data, next: more ? { offset: offset + ctx.limit, hash } : null };
  });
}
/** @param {ProjectionCtx} ctx @param {string} entity @param {string[]} ids */
async function fieldLoad(ctx, entity, ids) {
  if (entity === "field.manifest") throw rebootstrap();
  if (entity === "inventory")
    return new Map(
      (await inventoryRows(ctx, ids)).map((/** @type {any} */ r) => [r.id, r]),
    );
  const db = ctx.db;
  if (entity === "visit") {
    const rows =
      await db`select * from visit_executions where id in ${db(ids)} and assignee_profile_id=${ctx.actor.profileId}
      and service_date>=${ctx.params.dayFrom}::date and service_date<${ctx.params.dayFrom}::date+3 and deleted_at is null`;
    const values = new Map();
    for (const r of rows) {
      await outletInScope(ctx, r.outlet_id);
      values.set(r.id, {
        id: r.id,
        outletId: r.outlet_id,
        serviceDate: dateOf(r.service_date),
        state: r.state,
        productivity: r.productivity,
        plannedVisitId: r.planned_visit_id ?? null,
      });
    }
    return values;
  }
  const rows =
    await db`select a.* from visit_activities a join visit_executions v on v.id=a.visit_id
    where a.id in ${db(ids)} and a.assignee_profile_id=${ctx.actor.profileId} and v.assignee_profile_id=${ctx.actor.profileId}
      and v.service_date>=${ctx.params.dayFrom}::date and v.service_date<${ctx.params.dayFrom}::date+3 and a.deleted_at is null and v.deleted_at is null`;
  const values = new Map();
  for (const r of rows) {
    await outletInScope(ctx, r.outlet_id);
    values.set(r.id, {
      id: r.id,
      visitId: r.visit_id,
      kind: r.activity_kind,
      serverTime: ms(r.server_time),
    });
  }
  return values;
}
/** @param {any} ctx */
export function installProjections(ctx) {
  ctx.registerProjection("field.bundle", {
    params: (/** @type {any} */ p) => {
      if (p.schemeEngine !== undefined && p.schemeEngine !== 1)
        throw new ApiError(
          "version_unsupported",
          426,
          "Update the native promotion engine",
          false,
          { action: "update" },
        );
      return {
        dayFrom: serviceDate(p.dayFrom),
        ...(p.includeWorkforce === true ? { includeWorkforce: true } : {}),
        ...(p.schemeEngine === 1 ? { schemeEngine: 1 } : {}),
      };
    },
    snapshot: fieldSnapshot,
    entities: ["visit", "activity", "inventory", "field.manifest"],
    scopeKeys: async (/** @type {ProjectionCtx} */ p) => {
      await requireCapability(p, "visit.record");
      if (
        p.app === "van-android" ||
        p.params.dayFrom !== manilaDate(p.now) ||
        p.now >=
          (p.params.includeWorkforce === true
            ? midnight(p.params.dayFrom) + DAY_MS
            : closeAt(p.params.dayFrom))
      )
        throw rebootstrap();
      await checkDayManifest(p);
      return [
        `profile:${p.actor.profileId}`,
        "field:reference",
        ...p.scope.orgUnitIds.map((id) => `unit:${id}`),
      ];
    },
    load: fieldLoad,
    leaseExpiresAt: (/** @type {ProjectionCtx} */ p) =>
      p.params.includeWorkforce === true
        ? midnight(p.params.dayFrom) + DAY_MS
        : closeAt(p.params.dayFrom),
  });
  ctx.registerProjection("suggested-order", {
    params: (/** @type {any} */ p) => ({
      outletId: uuid(p.outletId),
      asOfDate: serviceDate(p.asOfDate),
    }),
    snapshot: suggestedOrder,
    scopeKeys: () => {
      throw rebootstrap("Refresh this report with a snapshot");
    },
  });
}
