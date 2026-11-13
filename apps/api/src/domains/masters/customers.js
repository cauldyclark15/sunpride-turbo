// SP-0170 customer master: the one writer and reader of the client's customer record.
// Customer = store: the `outlets` row is the customer (code = Customer Code, name = Customer
// Name, address = Customer Address); every other field of Sunpride's sheet lives in
// customer_profiles + customer_ship_tos. The accounting `customers` row is kept 1:1 with the
// same code in the same transaction (SPEC rule 2), its outlet_customer_links link kept current.
// Store creation, pins and deactivation reuse the existing outlet writers (org/outlets.js).
import {
  FIELDS,
  formatAddress,
  optionLabel,
  referenceIndex,
  shipToFromCustomer,
  validateCustomer,
} from "@sunpride/customer-master";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import {
  allocate,
  enrolmentCommand,
  outletCommand,
  pinCommand,
} from "../org/outlets.js";
import { access } from "../org/readers.js";
import { scopeFilterForActor } from "../org/scope.js";
import { get, replaceInterval, rule, uuid } from "../org/model.js";

/** Profile columns <-> API keys (customer fields kept on customer_profiles). */
export const PROFILE_COLUMNS = /** @type {const} */ ([
  ["registeredName", "registered_name"],
  ["tradeName", "trade_name"],
  ["email", "email"],
  ["mobileNo", "mobile_no"],
  ["telNo", "tel_no"],
  ["tin", "tin"],
  ["taxClassificationCode", "tax_classification_code"],
  ["countryCode", "country_code"],
  ["regionCode", "region_code"],
  ["provinceCode", "province_code"],
  ["municipalityCode", "municipality_code"],
  ["barangayCode", "barangay_code"],
  ["houseNo", "house_no"],
  ["street1", "street1"],
  ["street2", "street2"],
  ["floor", "floor"],
  ["roomStallNo", "room_stall_no"],
  ["postalCode", "postal_code"],
  ["salesOrgCode", "sales_org_code"],
  ["salesOfficeCode", "sales_office_code"],
  ["distributionChannelCode", "distribution_channel_code"],
  ["customerGroup1Code", "customer_group1_code"],
  ["customerGroup2Code", "customer_group2_code"],
  ["customerGroupCode", "customer_group_code"],
  ["typeOfBusiness", "type_of_business"],
  ["salesPartnerCode", "sales_partner_code"],
  ["paymentTermsCode", "payment_terms_code"],
  ["creditLimit", "credit_limit"],
  ["pricingProcedureCode", "pricing_procedure_code"],
  ["deliveringPlantCode", "delivering_plant_code"],
  ["distributorCode", "distributor_code"],
  ["distributorName", "distributor_name"],
  ["distributorCustomerCode", "distributor_customer_code"],
  ["distributionMode", "distribution_mode"],
  ["subDistributorCode", "sub_distributor_code"],
  ["subDistributorName", "sub_distributor_name"],
  ["distributorSalesman", "distributor_salesman"],
  ["distributorSalesmanCode", "distributor_salesman_code"],
  ["truckServing", "truck_serving"],
  ["truckCode", "truck_code"],
  ["distributorHub", "distributor_hub"],
  ["clusterNo", "cluster_no"],
  ["clusterName", "cluster_name"],
]);
/** Every client field key a request may send (ship-to entries come as `shipTos`). */
const INPUT_KEYS = new Set([
  ...PROFILE_COLUMNS.map(([k]) => k),
  "customerName",
  "customerAddress",
  "latitude",
  "longitude",
  "shipTos",
]);
/** List-backed keys and the name key returned beside them. */
const NAME_KEYS = /** @type {const} */ ([
  ["taxClassificationCode", "tax_classification", "taxClassificationName"],
  ["countryCode", "country", "countryName"],
  ["salesOrgCode", "sales_organization", "salesOrgName"],
  ["salesOfficeCode", "sales_office", "salesOfficeName"],
  [
    "distributionChannelCode",
    "distribution_channel",
    "distributionChannelName",
  ],
  ["customerGroup1Code", "customer_group_1", "customerGroup1Name"],
  ["customerGroup2Code", "customer_group_2", "customerGroup2Name"],
  ["customerGroupCode", "customer_group", "customerGroupName"],
  ["typeOfBusiness", "type_of_business", "typeOfBusinessName"],
  ["salesPartnerCode", "sales_partner", "salesPartnerName"],
  ["paymentTermsCode", "payment_terms", "paymentTermsName"],
  ["pricingProcedureCode", "pricing_procedure", "pricingProcedureName"],
  ["deliveringPlantCode", "delivering_plant", "deliveringPlantName"],
]);

/** @param {any} r */
const refDto = (r) => ({
  list: r.list,
  salesOrgCode: r.sales_org_code ?? r.salesOrgCode ?? "",
  channelCode: r.channel_code ?? r.channelCode ?? "",
  group1Code: r.group1_code ?? r.group1Code ?? "",
  code: r.code,
  name: r.name,
  label: optionLabel(r),
  active: r.active !== false,
});

/** Active reference rows plus the Sales Partner fallback (SPEC rule 7): while Sunpride's
 * "List of Agents" is empty, Sales Partner offers our active field/van sales employees.
 * @param {any} db */
export async function referenceRows(db) {
  const rows = (
    await db`select * from customer_reference_values where active order by list, sales_org_code, channel_code, group1_code, sort_order`
  ).map(refDto);
  if (!rows.some((/** @type {any} */ r) => r.list === "sales_partner")) {
    const people =
      await db`select coalesce(employee_code, id::text) as code, name from profiles where role='sales' and status='active' and deleted_at is null order by name limit 1000`;
    for (const p of people)
      rows.push(refDto({ list: "sales_partner", code: p.code, name: p.name }));
  }
  return rows;
}

/** Resolve the chosen PSGC codes with their parents for validation and display.
 * @param {any} db @param {Record<string, any>} v */
export async function resolveGeography(db, v) {
  const one = async (/** @type {any} */ q) => (await q)[0] ?? null;
  const region = v.regionCode
    ? await one(db`select code,name from ph_regions where code=${v.regionCode}`)
    : null;
  const province = v.provinceCode
    ? await one(
        db`select code,name,region_code as "regionCode" from ph_provinces where code=${v.provinceCode}`,
      )
    : null;
  const municipality = v.municipalityCode
    ? await one(
        db`select code,name,province_code as "provinceCode",region_code as "regionCode" from ph_municipalities where code=${v.municipalityCode}`,
      )
    : null;
  const barangay = v.barangayCode
    ? await one(
        db`select code,name,municipality_code as "municipalityCode" from ph_barangays where code=${v.barangayCode}`,
      )
    : null;
  const postalCodes = v.municipalityCode
    ? (
        await db`select postal_code from ph_postal_codes where municipality_code=${v.municipalityCode} order by postal_code`
      ).map((/** @type {any} */ r) => r.postal_code)
    : [];
  return { region, province, municipality, barangay, postalCodes };
}

/** @param {Record<string, any>} errorsHolder @returns {never} */
function invalid(errorsHolder) {
  throw new ApiError(
    "validation_failed",
    422,
    errorsHolder.errors[0]?.message ?? "Check the customer details.",
    false,
    { details: { errors: errorsHolder.errors } },
  );
}

/** @param {any} db @param {string} outletId */
async function currentPin(db, outletId) {
  const [pin] =
    await db`select * from outlet_pins where outlet_id=${outletId} and deleted_at is null and status in ('verified','pending')
      order by (status='verified' and effective_from<=now() and (effective_to is null or effective_to>now())) desc, proposed_at desc limit 1`;
  return pin ?? null;
}

/** Read one customer in the API shape. @param {any} db @param {string} id */
export async function readCustomer(db, id) {
  const [o] =
    await db`select o.*,p.*,o.created_at as outlet_created_at,o.updated_at as outlet_updated_at,
      p.outlet_id is not null as has_profile,
      (select l.customer_id from outlet_customer_links l where l.outlet_id=o.id and l.deleted_at is null and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now()) order by l.effective_from desc limit 1) as customer_id,
      (select a.territory_id from outlet_assignments a where a.outlet_id=o.id and a.deleted_at is null and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) order by a.effective_from desc limit 1) as territory_id
      from outlets o left join customer_profiles p on p.outlet_id=o.id and p.deleted_at is null where o.id=${id} and o.deleted_at is null`;
  if (!o) throw new ApiError("not_found", 404, "Customer not found.");
  const index = referenceIndex(await referenceRows(db));
  /** @type {Record<string, any>} */ const out = {
    id: o.id,
    code: o.code,
    status: o.status,
    completeness: o.completeness ?? "draft",
    enrolmentStatus: o.enrolment_status ?? null,
    customerName: o.name,
    customerAddress: o.address ?? null,
    addressCustom: o.address_custom ?? false,
  };
  for (const [key, column] of PROFILE_COLUMNS)
    out[key] =
      column === "credit_limit"
        ? o.credit_limit == null
          ? null
          : Number(o.credit_limit)
        : (o[column] ?? null);
  out.countryCode = o.country_code ?? "PH";
  out.regionName = o.region_name ?? null;
  out.provinceName = o.province_name ?? null;
  out.municipalityName = o.municipality_name ?? null;
  out.barangayName = o.barangay_name ?? null;
  for (const [key, list, nameKey] of NAME_KEYS) {
    const v = out[key];
    const opts = index.all(list).filter((r) => r.code === v);
    const match =
      opts.find(
        (r) =>
          (!r.salesOrgCode || r.salesOrgCode === out.salesOrgCode) &&
          (!r.channelCode || r.channelCode === out.distributionChannelCode) &&
          (!r.group1Code || r.group1Code === out.customerGroup1Code),
      ) ?? null;
    out[nameKey] = match?.name ?? null;
  }
  const pin = await currentPin(db, o.id);
  out.latitude = pin ? Number(pin.latitude) : null;
  out.longitude = pin ? Number(pin.longitude) : null;
  out.pinStatus = pin?.status ?? null;
  out.shipTos = (
    await db`select * from customer_ship_tos where outlet_id=${o.id} and deleted_at is null order by ordinal`
  ).map((/** @type {any} */ s) => ({
    id: s.id,
    ordinal: s.ordinal,
    sameAsCustomer: s.same_as_customer,
    shipToParty: s.ship_to_party,
    shipToAddress: s.ship_to_address,
    contactPerson: s.contact_person,
    mobileNo: s.mobile_no,
    email: s.email,
  }));
  out.custodianOrgUnitId = o.custodian_org_unit_id;
  out.territoryId = o.territory_id ?? null;
  out.accountingCustomerId = o.customer_id ?? null;
  out.legacyChannel = o.channel ?? null;
  // WEB-059: who proposed a pending field enrolment, so the web can disable Approve/Reject on one's own proposal
  // (the server refuses it anyway: org/outlets.js "The proposer cannot decide their own store").
  const [pending] =
    await db`select e.proposed_by_profile_id as profile_id
      from outlet_enrolments e where e.outlet_id=${o.id} and e.status='pending' and e.deleted_at is null order by e.created_at desc limit 1`;
  out.proposedByProfileId = pending?.profile_id ?? null;
  out.createdAt = new Date(o.outlet_created_at).getTime();
  out.updatedAt = new Date(o.outlet_updated_at).getTime();
  return out;
}

/** Accounting `customers` row 1:1 with the same code; link kept current (SPEC rule 2).
 * Never touches a customer shared by another store. @param {any} c @param {string} outletId */
export async function syncAccountingCustomer(c, outletId) {
  const [o] =
    await c.db`select o.*,p.credit_limit as profile_credit from outlets o left join customer_profiles p on p.outlet_id=o.id where o.id=${outletId}`;
  const [territory] =
    await c.db`select t.code from outlet_assignments a join territories t on t.id=a.territory_id where a.outlet_id=${outletId} and a.deleted_at is null order by (a.effective_to is null) desc, a.effective_from desc limit 1`;
  const [link] =
    await c.db`select l.*,cu.code as customer_code,(select count(*)::int from outlet_customer_links x where x.customer_id=l.customer_id and x.deleted_at is null and (x.effective_to is null or x.effective_to>now())) as sharers
      from outlet_customer_links l join customers cu on cu.id=l.customer_id where l.outlet_id=${outletId} and l.deleted_at is null and l.effective_from<=now() and (l.effective_to is null or l.effective_to>now()) order by l.effective_from desc limit 1`;
  // A field enrolment that is still provisional (or was rejected) gets no accounting customer:
  // its provisional code must never reach AR/SAP. Approval creates it with the final code.
  if (
    !link &&
    (o.enrolment_status === "provisional" || o.enrolment_status === "rejected")
  )
    return null;
  const values = {
    name: o.name,
    credit_limit: o.profile_credit ?? 0,
    active: o.status !== "inactive",
    channel: o.channel ?? "",
  };
  let customer = null;
  if (link && link.sharers === 1) {
    customer = await get(c.db, "customers", link.customer_id);
    if (customer.code !== o.code) {
      if (customer.external_id)
        rule(
          "This customer is already synced with SAP; its Customer Code cannot change here.",
          "code_locked",
        );
      const [taken] =
        await c.db`select id from customers where code=${o.code} and id<>${customer.id}`;
      if (taken)
        rule("Another customer already uses this Customer Code.", "code_taken");
    }
    [customer] =
      await c.db`update customers set code=${o.code},name=${values.name},credit_limit=${values.credit_limit},active=${values.active},channel=coalesce(nullif(channel,''),${values.channel})
        where id=${customer.id} returning *`;
    return customer;
  }
  [customer] = await c.db`select * from customers where code=${o.code}`;
  if (customer) {
    const [other] =
      await c.db`select 1 from outlet_customer_links where customer_id=${customer.id} and outlet_id<>${outletId} and deleted_at is null and (effective_to is null or effective_to>now())`;
    if (other)
      rule("Another customer already uses this Customer Code.", "code_taken");
    [customer] =
      await c.db`update customers set name=${values.name},credit_limit=${values.credit_limit},active=${values.active},deleted_at=null where id=${customer.id} returning *`;
  } else
    [customer] =
      await c.db`insert into customers(code,name,channel,territory,credit_limit,active) values(${o.code},${values.name},${values.channel},${territory?.code ?? "UNASSIGNED"},${values.credit_limit},${values.active}) returning *`;
  await replaceInterval(
    c.db,
    "outlet_customer_links",
    "outlet_id",
    outletId,
    Math.max(c.now, link ? new Date(link.effective_from).getTime() + 1 : c.now),
    {
      customer_id: customer.id,
      source: "customer_master",
      actor_subject: c.actor?.subject ?? "system:customer-master",
      reason: "Customer master keeps the accounting customer 1:1 (SP-0170)",
    },
  );
  return customer;
}

/** Fill server-derived values: Country default, PSGC names, the one-line Customer Address and
 * the first ship-to when "same as customer" is ticked. @param {any} db @param {Record<string, any>} merged @param {Record<string, any>} input @param {Record<string, any>|null} existing */
export async function derive(db, merged, input, existing) {
  if (!merged.countryCode) merged.countryCode = "PH";
  const geo = await resolveGeography(db, merged);
  merged.regionName = geo.region?.name ?? null;
  merged.provinceName = geo.province?.name ?? null;
  merged.municipalityName = geo.municipality?.name ?? null;
  merged.barangayName = geo.barangay?.name ?? null;
  const generated = formatAddress(merged);
  const typed =
    typeof input.customerAddress === "string" && input.customerAddress.trim()
      ? input.customerAddress.trim()
      : null;
  if (typed) {
    merged.customerAddress = typed;
    merged.addressCustom = typed !== generated;
  } else if (
    !existing ||
    !existing.addressCustom ||
    input.customerAddress === ""
  ) {
    merged.customerAddress = generated ?? existing?.customerAddress ?? null;
    merged.addressCustom = false;
  }
  if (Array.isArray(merged.shipTos))
    merged.shipTos = merged.shipTos.map((/** @type {any} */ s) =>
      s?.sameAsCustomer
        ? {
            ...shipToFromCustomer(merged, s.contactPerson ?? null),
            contactPerson: s.contactPerson ?? null,
          }
        : s,
    );
  return geo;
}

/**
 * Create (no `outletId`) or update a customer. Saves at `draft` level (field capture may be
 * incomplete); stores the completeness of the result. Returns the customer id.
 * @param {any} c @param {Record<string, any>} b @param {{outletId?:string, fieldCapture?:boolean}} [opts]
 */
export async function saveCustomer(c, b, opts = {}) {
  const input = b.customer ?? b;
  if (!input || typeof input !== "object" || Array.isArray(input))
    rule("Enter the customer details.");
  const unknown = Object.keys(input).filter(
    (k) =>
      !INPUT_KEYS.has(k) &&
      ![
        "code",
        "custodianOrgUnitId",
        "territoryId",
        "reason",
        "contactPerson",
        "status",
      ].includes(k),
  );
  if (unknown.length)
    throw new ApiError("invalid_request", 400, `Unknown field: ${unknown[0]}`);
  const existing = opts.outletId
    ? await readCustomer(c.db, opts.outletId)
    : null;
  if (existing?.status === "inactive") rule("This customer is inactive.");
  /** @type {Record<string, any>} */ const merged = { ...(existing ?? {}) };
  for (const key of INPUT_KEYS) if (key in input) merged[key] = input[key];
  const [hadProfile] = opts.outletId
    ? await c.db`select 1 from customer_profiles where outlet_id=${opts.outletId} and deleted_at is null`
    : [];
  if (
    !hadProfile &&
    !(Array.isArray(input.shipTos) && input.shipTos.length) &&
    b.sameAsCustomer !== false
  )
    merged.shipTos = [
      {
        sameAsCustomer: true,
        contactPerson: input.contactPerson ?? b.contactPerson ?? null,
      },
    ];
  const geo = await derive(c.db, merged, input, existing);
  const lists = await referenceRows(c.db);
  const draft = validateCustomer(merged, {
    level: "draft",
    lists,
    geography: geo,
  });
  if (!draft.ok) invalid(draft);
  const complete = validateCustomer(merged, {
    level: "complete",
    lists,
    geography: geo,
  });
  const v = draft.value;
  const actor = c.actor;
  const reason =
    typeof b.reason === "string" && b.reason.trim()
      ? b.reason.trim()
      : existing
        ? "Customer details updated"
        : "Customer added";
  /** @type {string} */ let outletId = opts.outletId ?? "";
  // Price/flow key on outlets.channel: the SAP Distribution Channel code for new-shape customers
  // (SAP prices by sales org + distribution channel); migrated samples keep their old key.
  const priceKey =
    v.distributionChannelCode &&
    (!existing ||
      existing.distributionChannelCode !== v.distributionChannelCode ||
      !existing.legacyChannel)
      ? v.distributionChannelCode
      : (existing?.legacyChannel ?? v.distributionChannelCode ?? null);
  if (!opts.outletId) {
    const unit = uuid(b.custodianOrgUnitId ?? actor.orgUnitId, "Area");
    outletId = /** @type {string} */ (
      await outletCommand(c, "create", {
        name: v.customerName,
        // Customer Code: SAP number when known, else the one store-code allocator
        // (editable by the office until SAP sync).
        code:
          typeof (b.code ?? input.code) === "string" &&
          (b.code ?? input.code).trim()
            ? (b.code ?? input.code)
            : await allocate(c, "customer"),
        custodianOrgUnitId: unit,
        status: "prospect",
        address: v.customerAddress ?? undefined,
        ...(priceKey ? { channel: priceKey } : {}),
        reason,
      })
    );
  } else {
    const fields = /** @type {Record<string, any>} */ ({});
    if (v.customerName !== existing?.customerName) fields.name = v.customerName;
    if ((v.customerAddress ?? null) !== (existing?.customerAddress ?? null))
      fields.address = v.customerAddress;
    if (priceKey && priceKey !== existing?.legacyChannel)
      fields.channel = priceKey;
    const newCode = b.code ?? input.code;
    if (
      typeof newCode === "string" &&
      newCode.trim() &&
      newCode.trim().toUpperCase() !== existing?.code
    ) {
      await requireCapability(c, "outlet.manage");
      const code = newCode.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code))
        rule("Invalid Customer Code.", "invalid_code");
      const [taken] =
        await c.db`select 1 from outlets where organization_id='sunpride' and code=${code} and id<>${outletId}`;
      if (taken)
        rule("Another customer already uses this Customer Code.", "code_taken");
      fields.code = code;
    }
    if (Object.keys(fields).length) {
      const sets = Object.keys(fields);
      await c.db.unsafe(
        `update outlets set ${sets.map((k, i) => `${k}=$${i + 2}`).join(",")} where id=$1`,
        [outletId, ...sets.map((k) => fields[k])],
      );
    }
  }
  const row = /** @type {Record<string, any>} */ ({
    outlet_id: outletId,
    completeness: complete.ok ? "complete" : "draft",
    source: existing ? undefined : opts.fieldCapture ? "field" : "api",
    updated_by: actor?.subject ?? actor?.userId ?? "system:customer-master",
    region_name: merged.regionName,
    province_name: merged.provinceName,
    municipality_name: merged.municipalityName,
    barangay_name: merged.barangayName,
    address_custom: merged.addressCustom ?? false,
  });
  for (const [key, column] of PROFILE_COLUMNS) row[column] = v[key] ?? null;
  // Denormalized names for readers (analytics view, mobile summaries).
  const names = referenceIndex(lists);
  /** @param {string} list @param {Record<string, string|null>} parent @param {string|null} code */
  const nameOf = (list, parent, code) =>
    code
      ? (names.options(list, parent).find((r) => r.code === code)?.name ?? null)
      : null;
  row.distribution_channel_name = nameOf(
    "distribution_channel",
    { salesOrgCode: v.salesOrgCode },
    v.distributionChannelCode,
  );
  row.customer_group1_name = nameOf(
    "customer_group_1",
    { salesOrgCode: v.salesOrgCode, channelCode: v.distributionChannelCode },
    v.customerGroup1Code,
  );
  row.customer_group2_name = nameOf(
    "customer_group_2",
    {
      salesOrgCode: v.salesOrgCode,
      channelCode: v.distributionChannelCode,
      group1Code: v.customerGroup1Code,
    },
    v.customerGroup2Code,
  );
  row.customer_group_name = nameOf("customer_group", {}, v.customerGroupCode);
  row.country_code = v.countryCode ?? "PH";
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  const cols = Object.keys(row);
  await c.db.unsafe(
    `insert into customer_profiles(${cols.join(",")}) values(${cols.map((_, i) => `$${i + 1}`).join(",")})
     on conflict(outlet_id) do update set ${cols
       .filter((k) => k !== "outlet_id")
       .map((k) => `${k}=excluded.${k}`)
       .join(",")}, deleted_at=null`,
    cols.map((k) => row[k]),
  );
  // Analytics tiles are gated by the outlets fingerprint: a profile change must move it too.
  await c.db`update outlets set updated_at=now() where id=${outletId}`;
  if (Array.isArray(input.shipTos) || !hadProfile) {
    await c.db`update customer_ship_tos set deleted_at=now() where outlet_id=${outletId} and deleted_at is null`;
    for (const [i, s] of (v.shipTos ?? []).entries())
      await c.db`insert into customer_ship_tos(outlet_id,ordinal,ship_to_party,ship_to_address,contact_person,mobile_no,email,same_as_customer,updated_by)
        values(${outletId},${i},${s.shipToParty},${s.shipToAddress},${s.contactPerson},${s.mobileNo},${s.email},${s.sameAsCustomer === true},${row.updated_by})`;
  }
  // Geographical Coordinates: a changed position becomes a PENDING pin (two-person verify).
  if (v.latitude != null && v.longitude != null) {
    const pin = await currentPin(c.db, outletId);
    if (
      !pin ||
      Math.abs(Number(pin.latitude) - v.latitude) > 1e-7 ||
      Math.abs(Number(pin.longitude) - v.longitude) > 1e-7
    )
      await pinCommand(c, "propose", {
        outletId,
        latitude: v.latitude,
        longitude: v.longitude,
        radiusMeters: 75,
        source: opts.fieldCapture ? "field_customer" : "customer_master",
        evidenceNote: "Geographical Coordinates from the customer record",
        reason,
      });
  }
  // Field drafts get their accounting customer when the office approves them.
  if (!opts.fieldCapture) await syncAccountingCustomer(c, outletId);
  await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details)
    values(${row.updated_by},${existing ? "customer.update" : "customer.create"},'outlets',${outletId},${JSON.stringify({ reason, completeness: row.completeness })})`;
  return outletId;
}

/** Approval/activation: only a `complete` customer becomes active (SPEC rule 10). A pending
 * field enrolment is decided through the existing enrolment writer (two-person rule kept).
 * @param {any} c @param {string} outletId @param {{reason?:string}} b */
export async function approveCustomer(c, outletId, b) {
  await requireCapability(c, "outlet.enrol.approve");
  await access(c, "outlets", outletId, "outlet.enrol.approve");
  const customer = await readCustomer(c.db, outletId);
  if (customer.status === "inactive") rule("This customer is inactive.");
  const lists = await referenceRows(c.db);
  const result = validateCustomer(customer, {
    level: "complete",
    lists,
    geography: await resolveGeography(c.db, customer),
  });
  if (!result.ok) invalid(result);
  const reason =
    typeof b.reason === "string" && b.reason.trim()
      ? b.reason.trim()
      : "Customer approved";
  const [enrolment] =
    await c.db`select id from outlet_enrolments where outlet_id=${outletId} and status='pending' and deleted_at is null`;
  if (enrolment)
    await enrolmentCommand(c, "decide", {
      enrolmentId: enrolment.id,
      decision: "approved",
      reason,
    });
  await c.db`update outlets set status='active' where id=${outletId} and status<>'active'`;
  await c.db`update customer_profiles set completeness='complete',updated_by=${c.actor?.subject ?? "system"} where outlet_id=${outletId}`;
  // A decided field enrolment already created the accounting customer (final code) in the
  // enrolment writer; a second interval in the same transaction would overlap it.
  if (!enrolment) await syncAccountingCustomer(c, outletId);
  await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${c.actor?.subject ?? "system"},'customer.approve','outlets',${outletId},${JSON.stringify({ reason })})`;
  return outletId;
}

/** Reject a field "Add customer" waiting for approval (the old New store approvals' Reject):
 * the pending enrolment is decided `rejected` through the existing enrolment writer (two-person
 * rule kept; the store becomes inactive, no accounting customer is created).
 * @param {any} c @param {string} outletId @param {{reason?:string}} b */
export async function rejectCustomer(c, outletId, b) {
  await requireCapability(c, "outlet.enrol.approve");
  await access(c, "outlets", outletId, "outlet.enrol.approve");
  const reason =
    typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : "";
  if (!reason) rule("Enter the reason for rejecting this customer.");
  const [enrolment] =
    await c.db`select id from outlet_enrolments where outlet_id=${outletId} and status='pending' and deleted_at is null`;
  if (!enrolment)
    rule(
      "Only a new customer from the field app waiting for approval can be rejected. Deactivate other customers.",
    );
  await enrolmentCommand(c, "decide", {
    enrolmentId: enrolment.id,
    decision: "rejected",
    reason,
  });
  await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${c.actor?.subject ?? "system"},'customer.reject','outlets',${outletId},${JSON.stringify({ reason })})`;
  return outletId;
}

/** Deactivate the store and its accounting customer together. @param {any} c @param {string} outletId @param {{reason?:string}} b */
export async function deactivateCustomer(c, outletId, b) {
  const reason =
    typeof b.reason === "string" && b.reason.trim()
      ? b.reason.trim()
      : "Customer deactivated";
  await outletCommand(c, "deactivate", { outletId, reason });
  await syncAccountingCustomer(c, outletId);
  await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${c.actor?.subject ?? "system"},'customer.deactivate','outlets',${outletId},${JSON.stringify({ reason })})`;
  return outletId;
}

/** Tolerant customer-code search key, the SQL side applies the same folding to the code.
 * @param {string} text */
export function compactCodeQuery(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/o/g, "0");
}

/** GET /api/v1/customers list, current-scope filtered. @param {any} c */
export async function listCustomers(c) {
  const actor = await requireCapability(c, "outlet.read");
  const { unitIds } = await scopeFilterForActor(c.db, actor);
  const q = c.url.searchParams;
  const text = (q.get("q") ?? "").trim().slice(0, 100);
  // EDGE-006/WEB-041: a code matches anywhere in it, ignoring case, spaces and dashes, letter O
  // read as zero ("smp c-OO69" finds SMP-C0069). Only [a-z0-9] survive, so it is LIKE-safe.
  const codeQ = compactCodeQuery(text);
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 50));
  const after = q.get("cursor") ?? "";
  // Page-number lists (office web): `offset` skips rows in code order and the reply carries `total`.
  const offsetRaw = q.get("offset");
  const offset =
    offsetRaw === null ? null : Math.max(0, Math.floor(Number(offsetRaw)) || 0);
  /** @param {string} name */
  const param = (name) => {
    const v = q.get(name);
    return v && v.trim() ? v.trim() : null;
  };
  const status = param("status");
  if (status && !["prospect", "active", "inactive"].includes(status))
    throw new ApiError("invalid_request", 400, "Unknown status.");
  const completeness = param("completeness");
  // The office approval queue: prospects plus field enrolments still provisional (the phone's
  // "Add customer" store is active with a provisional code so the rep can visit it at once).
  const awaiting = ["true", "1"].includes(param("awaitingApproval") ?? "");
  const nationwide = unitIds === null;
  const rows =
    await c.db`select x.*,count(*) over() as total_count from (select o.id,o.code,o.name,o.address,o.status,o.enrolment_status,p.completeness,p.registered_name,
      count(*) over() as n_all,count(*) filter (where o.status='prospect') over() as n_prospect,
      count(*) filter (where o.status='active') over() as n_active,count(*) filter (where o.status='inactive') over() as n_inactive,
      p.sales_org_code,p.distribution_channel_code,p.customer_group1_code,p.customer_group2_code,p.customer_group_code,
      p.sales_office_code,p.municipality_name,p.barangay_name,s.channel as distribution_channel_name,s.subchannel as customer_group1_name,
      s.customer_group2_name,s.customer_group_name,s.territory_id,s.territory_name
    from analytics_store_scope s join outlets o on o.id=s.id left join customer_profiles p on p.outlet_id=o.id and p.deleted_at is null
    where (${nationwide} or s.owner_unit_id::text=any(${c.db.array(unitIds ?? [], "TEXT")}))
      and (${!awaiting} or (o.status='prospect' or (o.status='active' and o.enrolment_status='provisional')))
      and (${completeness}::text is null or coalesce(p.completeness,'draft')=${completeness})
      and (${param("salesOrgCode")}::text is null or p.sales_org_code=${param("salesOrgCode")})
      and (${param("distributionChannelCode")}::text is null or p.distribution_channel_code=${param("distributionChannelCode")})
      and (${param("customerGroup1Code")}::text is null or p.customer_group1_code=${param("customerGroup1Code")})
      and (${param("customerGroupCode")}::text is null or p.customer_group_code=${param("customerGroupCode")})
      and (${param("salesOfficeCode")}::text is null or p.sales_office_code=${param("salesOfficeCode")})
      and (${param("customerGroup2Code")}::text is null or p.customer_group2_code=${param("customerGroup2Code")})
      and (${text === ""} or o.name ilike ${"%" + text.replace(/[%_\\]/g, "\\$&") + "%"} or (${codeQ !== ""} and translate(regexp_replace(lower(o.code),'[^a-z0-9]','','g'),'o','0') like ${"%" + codeQ + "%"}) or p.registered_name ilike ${"%" + text.replace(/[%_\\]/g, "\\$&") + "%"})
    ) x
    where (${status}::text is null or x.status=${status})
      and (${offset !== null} or x.code > ${after})
    order by x.code limit ${limit + 1} offset ${offset ?? 0}`;
  // WEB-040: chip counts for the current search/filters, whatever status is chosen.
  /** @type {Record<string,number>|null} */ let statusCounts = null;
  if (offset !== null) {
    const any =
      rows[0] ??
      (status
        ? (
            await c.db`select count(*) as n_all,count(*) filter (where o.status='prospect') as n_prospect,count(*) filter (where o.status='active') as n_active,count(*) filter (where o.status='inactive') as n_inactive from analytics_store_scope s join outlets o on o.id=s.id left join customer_profiles p on p.outlet_id=o.id and p.deleted_at is null
              where (${nationwide} or s.owner_unit_id::text=any(${c.db.array(unitIds ?? [], "TEXT")}))
                and (${!awaiting} or (o.status='prospect' or (o.status='active' and o.enrolment_status='provisional')))
                and (${completeness}::text is null or coalesce(p.completeness,'draft')=${completeness})
                and (${param("salesOrgCode")}::text is null or p.sales_org_code=${param("salesOrgCode")})
                and (${param("distributionChannelCode")}::text is null or p.distribution_channel_code=${param("distributionChannelCode")})
                and (${param("customerGroup1Code")}::text is null or p.customer_group1_code=${param("customerGroup1Code")})
                and (${param("customerGroupCode")}::text is null or p.customer_group_code=${param("customerGroupCode")})
                and (${param("salesOfficeCode")}::text is null or p.sales_office_code=${param("salesOfficeCode")})
                and (${param("customerGroup2Code")}::text is null or p.customer_group2_code=${param("customerGroup2Code")})
                and (${text === ""} or o.name ilike ${"%" + text.replace(/[%_\\]/g, "\\$&") + "%"} or (${codeQ !== ""} and translate(regexp_replace(lower(o.code),'[^a-z0-9]','','g'),'o','0') like ${"%" + codeQ + "%"}) or p.registered_name ilike ${"%" + text.replace(/[%_\\]/g, "\\$&") + "%"})`
          )[0]
        : null);
    statusCounts = {
      all: Number(any?.n_all ?? 0),
      prospect: Number(any?.n_prospect ?? 0),
      active: Number(any?.n_active ?? 0),
      inactive: Number(any?.n_inactive ?? 0),
    };
  }
  return {
    rows: rows.slice(0, limit).map((/** @type {any} */ r) => ({
      id: r.id,
      code: r.code,
      customerName: r.name,
      registeredName: r.registered_name ?? null,
      customerAddress: r.address ?? null,
      status: r.status,
      enrolmentStatus: r.enrolment_status ?? null,
      completeness: r.completeness ?? "draft",
      salesOrgCode: r.sales_org_code ?? null,
      salesOfficeCode: r.sales_office_code ?? null,
      distributionChannelCode: r.distribution_channel_code ?? null,
      distributionChannelName: r.distribution_channel_code
        ? r.distribution_channel_name
        : null,
      customerGroup1Code: r.customer_group1_code ?? null,
      customerGroup1Name: r.customer_group1_code
        ? r.customer_group1_name
        : null,
      customerGroup2Code: r.customer_group2_code ?? null,
      customerGroup2Name: r.customer_group2_name ?? null,
      customerGroupCode: r.customer_group_code ?? null,
      customerGroupName: r.customer_group_name ?? null,
      municipalityName: r.municipality_name ?? null,
      barangayName: r.barangay_name ?? null,
      territoryId: r.territory_id ?? null,
      territoryName: r.territory_name ?? null,
    })),
    nextCursor: rows.length > limit ? rows[limit - 1].code : null,
    ...(offset === null
      ? {}
      : { total: rows.length ? Number(rows[0].total_count) : 0, statusCounts }),
  };
}

/** The field list for web forms and upload templates. */
export function fieldList() {
  return FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    section: f.section,
    required: f.required,
    kind: f.kind,
    list: f.list ?? null,
    shipTo: f.shipTo === true,
    adp: f.adp === true,
    max: f.max ?? null,
  }));
}

/** Mobile bootstrap/sync summary per store (SP-0170, ADDITIVE): `channel` is the Distribution
 * Channel name (the old display key, now from the client's data) and `customerMaster` carries the
 * client's classification. Price keys (`channelKey`) are untouched.
 * @param {any} db @param {string[]} ids
 * @returns {Promise<Map<string, {channel:string|null, customerMaster:Record<string, string|null>}>>} */
export async function customerMasterSummaries(db, ids) {
  /** @type {Map<string, any>} */ const out = new Map();
  if (!ids.length) return out;
  const rows =
    await db`select s.id,s.channel,s.subchannel,s.sales_org_code,s.distribution_channel_code,s.customer_group1_code,
      s.customer_group2_code,s.customer_group2_name,s.customer_group_code,s.customer_group_name,p.completeness
      from analytics_store_scope s left join customer_profiles p on p.outlet_id=s.id and p.deleted_at is null
      where s.id in ${db(ids)}`;
  for (const r of rows)
    out.set(r.id, {
      channel: r.distribution_channel_code ? r.channel : null,
      customerMaster: {
        salesOrgCode: r.sales_org_code ?? null,
        distributionChannelCode: r.distribution_channel_code ?? null,
        distributionChannelName: r.distribution_channel_code ? r.channel : null,
        customerGroup1Code: r.customer_group1_code ?? null,
        customerGroup1Name: r.customer_group1_code ? r.subchannel : null,
        customerGroup2Code: r.customer_group2_code ?? null,
        customerGroup2Name: r.customer_group2_name ?? null,
        customerGroupCode: r.customer_group_code ?? null,
        customerGroupName: r.customer_group_name ?? null,
        completeness: r.completeness ?? null,
      },
    });
  return out;
}
