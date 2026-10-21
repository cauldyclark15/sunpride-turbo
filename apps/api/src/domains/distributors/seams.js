import { fail, integer, master, policy, dayAdd, today, text } from "./model.js";
import {
  distributorCredit,
  enqueueDistributorPosting,
} from "../integration/spec-adapters.js";
import { configurations } from "../callflow/engine.js";
import { roleHas } from "../../core/capabilities.js";

// SEAM(SAP): replace these local reference adapters with domains/integration's
// sapCreditCheck / enqueueSapPosting at integration. Only EXPLICIT sample masters
// simulate acknowledgements. A real/SAP snapshot cannot manufacture an approval.
/** @param {any} c @param {any} d @param {number} addCentavos */
export async function sapCreditCheck(c, d, addCentavos = 0) {
  integer(addCentavos);
  if (c.env?.SAP_MODE) return distributorCredit(c, d, addCentavos);
  const m = await master(c, d.id);
  const p = await policy(c, d.id);
  const credit = m.payload.credit;
  if (!credit || !Number.isFinite(Date.parse(credit.checkedAt)))
    return { status: "unknown", source: m.source };
  const age = c.now - Date.parse(credit.checkedAt);
  if (age < -60_000 || age > integer(p.creditMaxAgeSeconds, 1, 86400) * 1000)
    return { status: "stale", source: m.source, checkedAt: credit.checkedAt };
  // Live credit requires the SAP call owner; cached replicas are never an authority.
  if (m.source !== "sample")
    return {
      status: "unknown",
      source: "sap",
      reason: "Live SAP credit adapter not connected",
    };
  const limit = integer(credit.limitCentavos),
    sapExposure = integer(credit.exposureCentavos);
  const [pending] =
    await c.db`select coalesce(sum(total_centavos),0)::text as amount from orders where purchasing_distributor_id=${d.id} and status not in ('rejected','voided','fulfilled','posted')`;
  const commitments = integer(Number(pending.amount));
  const exposure = integer(sapExposure + commitments);
  return {
    status: exposure + addCentavos <= limit ? "within" : "over",
    limitCentavos: limit,
    exposureCentavos: exposure,
    additionalCentavos: addCentavos,
    checkedAt: credit.checkedAt,
    source: "sample",
    authority: "Mock SAP",
    ageing: credit.ageing ?? {},
  };
}
/** @param {any} c @param {any} d @param {string} kind @param {string} key @param {any} payload */
export async function enqueueSapPosting(c, d, kind, key, payload) {
  if (c.env?.SAP_MODE)
    return enqueueDistributorPosting(c, d, kind, key, payload);
  const m = await master(c, d.id);
  /** @type {any} */ let acknowledgement = null;
  if (m.source === "sample") {
    if (kind === "business_partner" && m.payload.mockSapCustomerCode)
      acknowledgement = {
        customerCode: text(m.payload.mockSapCustomerCode),
        source: "sample",
        authority: "Mock SAP",
      };
    if (kind === "primary_order")
      acknowledgement = {
        reference: `MOCK-${key}`,
        deliveryDate: dayAdd(
          today(c.now),
          integer(m.payload.terms.deliveryLeadDays, 0, 90),
        ),
        source: "sample",
        authority: "Mock SAP",
      };
    if (kind === "remittance")
      acknowledgement = {
        reference: `MOCK-${key}`,
        source: "sample",
        authority: "Mock SAP",
      };
  }
  const [request] =
    await c.db`insert into distributor_sap_requests(distributor_id,kind,request_key,payload,status,acknowledgement,source) values(${d.id},${kind},${key},${payload},${acknowledgement ? "acknowledged" : "pending"},${acknowledgement},${m.source}) returning *`;
  return request;
}
// SEAM(CALLFLOW): consume this configuration in the ONE engine. No visit writer
// or duplicate call flow is installed here; the native configuration lands there.
/** @param {any} c @param {any} d */
export async function distributorCallflowConfig(c, d) {
  const [member] =
    await c.db`select id,grants,effective_to from distributor_users where distributor_id=${d.id} and profile_id=${c.actor.profileId} and effective_from<=now() and (effective_to is null or effective_to>now())`;
  if (c.actor.role === "distributor" && !member?.grants.includes("dsr"))
    fail("DSR grant required", "forbidden", 403);
  const outlets =
    await c.db`select o.id,o.code,o.name,g.territory_id from distributor_outlets g join outlets o on o.id=g.outlet_id where g.distributor_id=${d.id} and g.effective_from<=now() and (g.effective_to is null or g.effective_to>now()) and o.deleted_at is null order by o.code`;
  const configs = await configurations(
    c.db,
    "distributor_rep",
    outlets,
    c.now,
    c.device ? { profileId: c.actor.profileId, deviceId: c.device.id } : null,
  );
  return {
    configurations: Object.fromEntries(configs),
    engine: "callflow",
    configuration: "distributor_rep",
    distributorId: d.id,
    membershipId: member?.id ?? null,
    validUntil: member?.effective_to ?? null,
    grants: member?.grants ?? [],
    outlets,
    source: "partner_grants",
    nativeReady: outlets.length > 0 && configs.size === outlets.length,
    fieldApp: "field-android",
    access: "Dedicated field invitation; portal logins remain separate",
    seam: "CALLFLOW",
    requiredSharedModules: ["pjp", "msl", "availability"],
  };
}
// SEAM(VANOPS): pass the partner owner and grants into the existing engine.
// Never route a partner to the employee van writer before it enforces ownership.
/** @param {any} c @param {any} d */
export async function distributorVanContext(c, d) {
  const arrangements =
    await c.db`select a.*,v.vehicle_code as code,v.name,v.truck_location_id as inventory_location_id from distributor_van_arrangements a join vehicles v on v.id=a.vehicle_id where a.distributor_id=${d.id} and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) and v.status='active' and v.deleted_at is null order by v.vehicle_code`;
  const operators =
    await c.db`select p.id,p.name from distributor_users u join profiles p on p.id=u.profile_id where u.distributor_id=${d.id} and 'van'=any(u.grants) and u.effective_from<=now() and (u.effective_to is null or u.effective_to>now()) and p.role='sales' and p.status='active' and p.deleted_at is null and p.user_id is not null and p.org_unit_id=${d.org_unit_id} and exists(select 1 from employee_assignments e where e.profile_id=p.id and e.role='sales' and e.org_unit_id=p.org_unit_id and e.effective_from<=now() and (e.effective_to is null or e.effective_to>now()) and e.deleted_at is null) order by p.name`;
  const [stores] =
    await c.db`select count(*)::int as n from distributor_outlets where distributor_id=${d.id} and effective_from<=now() and (effective_to is null or effective_to>now())`;
  const trips =
    await c.db`select id,trip_number,service_date,status,salesperson_profile_id from van_trips where distributor_id=${d.id} and deleted_at is null order by service_date desc,created_at desc limit 51`;
  const vehicleOptions = roleHas(c.actor.role, "van.manage")
    ? await c.db`select id,vehicle_code as code,name from vehicles where org_unit_id=${d.org_unit_id} and status='active' and deleted_at is null order by vehicle_code limit 501`
    : [];
  if (vehicleOptions.length > 500)
    fail("Narrow the supervising area before configuring a van");
  const ready = arrangements.length > 0 && operators.length > 0 && stores.n > 0;
  return {
    engine: "van",
    distributorId: d.id,
    vans: arrangements,
    arrangements,
    operators,
    vehicleOptions,
    trips: trips.slice(0, 50),
    tripsTruncated: trips.length > 50,
    ready,
    app: "van-sales-android",
    stockOwnership:
      "Explicit Sunpride-owned consignment; the company stock and SAP ledgers remain authoritative",
    seam: "VANOPS",
    message: ready
      ? "Use the existing Van/Store APK with the dedicated van login. The office plans trips and independently approves loads and settlement; only assigned partner stores are available."
      : "Configure a consignment vehicle, invite and activate a dedicated van operator, and assign its partner stores. No second app or settlement ledger is required.",
  };
}
