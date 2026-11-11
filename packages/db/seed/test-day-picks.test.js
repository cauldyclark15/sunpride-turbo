import { afterAll, beforeAll, expect, test } from "bun:test";
import { cashierFor, unitLevelSeries } from "./test-day-picks.js";
import { startHarness, createUser } from "../../../apps/api/test/harness.js";

/** @type {any} */ let h;
const unit = crypto.randomUUID();
beforeAll(async () => {
  h = await startHarness();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','TDP','Sample','national','active',now()-interval '1 day')`;
  const admin = await createUser(h, "tdp-admin@example.test", "test-only-password");
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${admin},${admin},${admin},'A','tdp-admin@example.test','admin','active',${unit})`;
  // Van registration first (its series is van-bound), then the seed's own store registration.
  const [van] =
    await h.db`insert into fiscal_registrations(org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample,tax_basis_points,created_at) values(${unit},'S','b','S','a','sales_invoice','draft','2026-01-01',${admin},false,1200,now()-interval '1 hour') returning id`;
  const [store] =
    await h.db`insert into fiscal_registrations(org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample,tax_basis_points) values(${unit},'S','b','S','a','sales_invoice','draft','2026-01-01',${admin},false,1200) returning id`;
  const v = crypto.randomUUID(), loc = crypto.randomUUID();
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${loc},'sunpride',${unit},'T','TDP-T','t','truck',true,true,true,true,false)`;
  await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${v},'sunpride',${unit},'TDP-V','T',${loc},${loc},'active','fixture')`;
  await h.db`insert into fiscal_series(registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from) values(${van.id},${v},'TDP-VAN-SI',1,9,1,'2026-01-01'),(${store.id},null,'TDP-STORE-SI',1,9,1,'2026-01-01')`;
});
afterAll(async () => h?.close());

test("NF-2 kit sees the store's branch-level series on any registration, so it adds no second one", async () => {
  expect((await unitLevelSeries(h.db, unit, "sales_invoice"))?.prefix).toBe("TDP-STORE-SI");
  expect(await unitLevelSeries(h.db, unit, "credit_memo")).toBeNull();
});

test("pos-tills: the cashier is a tester who works in the store's unit", () => {
  const people = [
    { email: "agent@", org_unit_id: "field" },
    { email: "van@", org_unit_id: "vans" },
  ];
  expect(cashierFor("vans", people)).toBe("van@");
  expect(cashierFor("field", people)).toBe("agent@");
  expect(cashierFor("elsewhere", people)).toBeNull();
});
