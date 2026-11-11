import { afterAll, beforeAll, expect, test } from "bun:test";
import { accentedNamesMissing, cashierFor, sapOwnedOutletCodes, unitLevelSeries } from "./test-day-picks.js";
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

test("r4 pos-tills: the kit sees every series the API's NF-2 tie rule would refuse next to (future-dated too), and only those", async () => {
  // r4: test-day pos-tills hit "422 Series ... already numbers these sales invoices at this level". The kit's own
  // check must use the API's tie predicate, else a series it misses makes the API refuse the kit's create.
  const other = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${other},'sunpride','TDP2','Sample 2','national','active',now()-interval '1 day')`;
  const [reg] =
    await h.db`insert into fiscal_registrations(org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample,tax_basis_points) select ${other},'S','b','S','a','credit_memo','draft','2026-01-01',entered_by,false,1200 from fiscal_registrations where org_unit_id=${unit} limit 1 returning id`;
  // Starts tomorrow: still numbers this level from tomorrow, so the API refuses a second open-ended one.
  await h.db`insert into fiscal_series(registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from) values(${reg.id},null,'TDP2-FUTURE-CM',1,9,1,now()+interval '1 day')`;
  expect((await unitLevelSeries(h.db, other, "credit_memo"))?.prefix).toBe("TDP2-FUTURE-CM");
  // Used up: the API lets a new range in, so the kit must create one.
  await h.db`update fiscal_series set next_allocate=last_serial+1 where prefix='TDP2-FUTURE-CM'`;
  expect(await unitLevelSeries(h.db, other, "credit_memo")).toBeNull();
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

test("accent-names: a name held only by a SAP-keyed outlet is missing (SAP puts its own name back); an office outlet keeps it", async () => {
  const names = ["Sample Tindahan ni Aling Peña", "Sample Café Ébano Store", "Sample St. Jude Sari-sari"];
  const outlet = (/** @type {string} */ code, /** @type {string} */ name) =>
    h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values('sunpride',${code},${name},'active',${unit},'fixture')`;
  // r3: the kit renamed SAP sample outlets; SAP still sends them, so the next masters pull restored their names.
  await outlet("TDP-SAP-1", names[0]);
  await h.db`insert into sap_replicas(organization_id,master_id,kind,sap_key,sap_version,source,effective_from,payload_hash,payload)
    values('sunpride',${crypto.randomUUID()},'outlet','TDP-SAP-1','1','sample',now(),'h',${{ data: { code: "TDP-SAP-1", name: "Sample Sari-sari 1" } }})`;
  expect([...(await sapOwnedOutletCodes(h.db, ["TDP-SAP-1", "TD-ACC-2"]))]).toEqual(["TDP-SAP-1"]);
  expect(await accentedNamesMissing(h.db, names)).toEqual(names);
  await outlet("TD-ACC-1", names[0]);
  await outlet("TD-ACC-2", names[1]);
  expect(await accentedNamesMissing(h.db, names)).toEqual([names[2]]);
  await outlet("TD-ACC-3", names[2]);
  expect(await accentedNamesMissing(h.db, names)).toEqual([]);
  // The exact strings are stored (no mojibake).
  const [row] = await h.db`select name from outlets where code='TD-ACC-2'`;
  expect(row.name).toBe("Sample Café Ébano Store");
});
