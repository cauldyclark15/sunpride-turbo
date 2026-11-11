// NF-2: a handheld must get one sales-invoice range even when several series of the type apply to its branch.
// Most specific wins: this register's own (device-bound) registration, then the van's series, then the branch's.
import { beforeAll, afterAll, expect, test } from "bun:test";
import { startHarness, profileStore, boundDevice, createUser } from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { tx } from "@sunpride/db/client";
import { install } from "../src/domains/fiscal/index.js";
import { saveRegistration, createSeries } from "../src/domains/fiscal/series.js";
import { fiscalBundle } from "../src/domains/fiscal/transactions.js";
import { today } from "../src/domains/van/model.js";

/** @type {any} */ let h;
/** @type {any} */ let people;
/** @type {any} */ let approver;

/** One fresh branch with a seller handheld. @param {string} tag */
async function branch(tag) {
  const unit = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride',${"NF2-" + tag},'Sample branch','national','active',now()-interval '1 day')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('nf2-test','org_units',${unit},${tag})`;
  const seller = await boundDevice(h, people, { app: "van-android", orgUnitId: unit });
  const p = seller.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${seller.userId},${seller.userId},'Seller',${seller.email},${p.role},'active',${unit})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','fixture','fixture')`;
  const location = crypto.randomUUID(),
    vehicle = crypto.randomUUID();
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${location},'sunpride',${unit},'TEST',${"T-" + tag},'Sample truck','truck',true,true,true,true,false)`;
  await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${vehicle},'sunpride',${unit},${"V-" + tag},'TEST',${location},${location},'active','fixture')`;
  const actor = /** @type {any} */ (await actorFor(h.db, seller.userId));
  await h.db`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,started_device_id,created_by) values(${crypto.randomUUID()},'sunpride',${unit},${"TRIP-" + tag},${vehicle},${location},${location},${today()},${actor.profileId},${actor.subject},'active',${seller.deviceId},'fixture')`;
  return { unit, vehicle, seller, actor };
}
/** @param {string} unit @param {string} type @param {string|null} [deviceId] */
const registration = (unit, type, deviceId = null) =>
  tx(h.db, (db) =>
    saveRegistration(db, approver, {
      orgUnitId: unit,
      entityName: "SAMPLE company",
      branchName: "Sample branch",
      tin: "SAMPLE 000-000",
      address: "Sample address",
      documentType: type,
      status: "sample_not_filed",
      effectiveFrom: "2026-01-01T00:00:00Z",
      ...(deviceId ? { deviceId } : {}),
    }),
  );
/** @param {string} registrationId @param {string} prefix @param {string|null} [vehicleId] */
const series = (registrationId, prefix, vehicleId = null) =>
  tx(h.db, (db) =>
    createSeries(db, approver, {
      registrationId,
      prefix,
      firstSerial: "1",
      lastSerial: "1000",
      effectiveFrom: "2026-01-01T00:00:00Z",
      ...(vehicleId ? { vehicleId } : {}),
    }),
  );
/** @param {any} b @param {string|null} vehicleId */
const bundle = (b, vehicleId) =>
  tx(h.db, (db) =>
    fiscalBundle(db, b.actor, { org_unit_id: b.unit, vehicle_id: vehicleId }, b.seller.deviceId),
  );
const prefixOf = (/** @type {any} */ out, /** @type {string} */ type) =>
  out.ranges.find((/** @type {any} */ r) => r.documentType === type)?.prefix;

beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  people = profileStore(h);
  h.setHooks({ unitInScope: async () => true });
  const office = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${office},'sunpride','NF2-OFFICE','Office','national','active',now()-interval '1 day')`;
  const boss = await createUser(h, "nf2boss@example.com", "a-test-password-only");
  const bp = people.set(boss, { role: "super_admin", orgUnitId: office, name: "Office" });
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${bp.id},${boss},${boss},'Office','nf2boss@example.com','super_admin','active',${office})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${bp.id},${office},'super_admin',now()-interval '1 day','fixture','fixture')`;
  approver = await actorFor(h.db, boss);
});
afterAll(async () => h?.close());

test("NF-2 van: the van's own series beats the branch-level ones", async () => {
  const b = await branch("van");
  const si = await registration(b.unit, "sales_invoice");
  await series(si.id, "NF2-VAN-UNIT-SI");
  await series(si.id, "NF2-VAN-OWN-SI", b.vehicle);
  const or = await registration(b.unit, "official_receipt");
  await series(or.id, "NF2-VAN-OR", b.vehicle);
  const out = await bundle(b, b.vehicle);
  expect(prefixOf(out, "sales_invoice")).toBe("NF2-VAN-OWN-SI");
  expect(prefixOf(out, "official_receipt")).toBe("NF2-VAN-OR");
  // Repeat download keeps the same range, still from the van's series.
  expect(prefixOf(await bundle(b, b.vehicle), "sales_invoice")).toBe("NF2-VAN-OWN-SI");
});

test("NF-2 store till: a registration bound to this register beats the branch-level series", async () => {
  const b = await branch("till");
  const unitReg = await registration(b.unit, "sales_invoice");
  await series(unitReg.id, "NF2-TILL-UNIT-SI");
  const tillReg = await registration(b.unit, "sales_invoice", b.seller.deviceId);
  await series(tillReg.id, "NF2-TILL-OWN-SI");
  expect(prefixOf(await bundle(b, null), "sales_invoice")).toBe("NF2-TILL-OWN-SI");
});

test("NF-2 a series bound to another register is never offered", async () => {
  const b = await branch("other");
  const other = await boundDevice(h, people, { app: "van-android", orgUnitId: b.unit });
  // The other till's machine registration sits in this branch too (two tills, one store).
  const unitReg = await registration(b.unit, "sales_invoice");
  await series(unitReg.id, "NF2-OTHER-UNIT-SI");
  const foreign = await registration(b.unit, "sales_invoice", other.deviceId);
  await series(foreign.id, "NF2-OTHER-FOREIGN-SI");
  expect(prefixOf(await bundle(b, null), "sales_invoice")).toBe("NF2-OTHER-UNIT-SI");
});

test("NF-2 two series at the same level are an office setup error, never a silent missing range", async () => {
  const b = await branch("tie");
  const si = await registration(b.unit, "sales_invoice");
  await series(si.id, "NF2-TIE-A-SI");
  // Legacy/hand-entered data: the office form now refuses this tie (asserted below), SQL does not.
  await h.db`insert into fiscal_series(registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from) values(${si.id},null,'NF2-TIE-B-SI',1,1000,1,'2026-01-01')`;
  let message = "";
  try {
    await bundle(b, null);
  } catch (e) {
    message = String(/** @type {any} */ (e).message);
  }
  expect(message).toContain("NF2-TIE-A-SI");
  expect(message).toContain("NF2-TIE-B-SI");
  expect(message).toContain("office");
  // The office cannot create the tie in the first place either.
  const c = await branch("tie2");
  const r2 = await registration(c.unit, "sales_invoice");
  await series(r2.id, "NF2-TIE2-A-SI", c.vehicle);
  let created = "";
  try {
    await series(r2.id, "NF2-TIE2-B-SI", c.vehicle);
  } catch (e) {
    created = String(/** @type {any} */ (e).message);
  }
  expect(created).toContain("NF2-TIE2-A-SI");
});
