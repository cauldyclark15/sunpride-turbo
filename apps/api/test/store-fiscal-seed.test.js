import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, createUser } from "./harness.js";
import {
  seedFiscal,
  seedStoreFiscal,
  seedRefundSeries,
} from "../../../packages/db/seed/fiscal.js";
import { tenderPolicy } from "../src/domains/fiscal/tenders.js";

/** @type {any} */ let h;
const bare = crypto.randomUUID(),
  seeded = crypto.randomUUID();
let admin = "";
/** @param {string} unit @param {string} code */
async function store(unit, code) {
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride',${code},${"Sample " + code},'national','active',now()-interval '1 day')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('store-fiscal','org_units',${unit},${"unit-" + code})`;
  const [l] =
    await h.db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values('sunpride',${unit},'CEBU',${code},${"Store " + code},'store',true,true,true,true,false) returning id`;
  await h.db`insert into store_registers(location_id,terminal_code,name,effective_from) values(${l.id},${code + "-01"},'Till',now())`;
}
beforeAll(async () => {
  h = await startHarness();
  await store(bare, "STORE-BARE");
  await store(seeded, "STORE-SEEDED");
  admin = await createUser(
    h,
    "sample-admin@example.test",
    "test-only-store-password",
  );
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${admin},${admin},${admin},'Sample Admin','sample-admin@example.test','admin','active',${bare})`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('store-fiscal','profiles',${admin},'admin') on conflict do nothing`;
});
afterAll(async () => h?.close?.());

test("a sample store register gets cash/GCash/card and one vehicle-less invoice series, once", async () => {
  // Office already made a disabled GCash rule and an invoice series for one store: leave them alone.
  const [reg] =
    await h.db`insert into fiscal_registrations(org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample,tax_basis_points) values(${seeded},'SAMPLE','b','SAMPLE 000','a','sales_invoice','sample_not_filed','2026-01-01',${admin},true,1200) returning id`;
  await h.db`insert into fiscal_series(registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from) values(${reg.id},null,'OFFICE-SI',1,50,1,'2026-01-01')`;
  await h.db`insert into fiscal_tender_rules(org_unit_id,method,label,enabled,effective_from,sample,entered_by) values(${seeded},'gcash','GCash',false,'2026-01-01',true,${admin})`;

  const first = await seedStoreFiscal(h.db);
  expect(first.series).toBe(1);
  expect(first.tenders).toBe(3 + 2);
  expect(await seedStoreFiscal(h.db)).toEqual({ tenders: 0, series: 0 });

  expect(
    (await tenderPolicy(h.db, bare))
      .map((/** @type {any} */ m) => m.code)
      .sort(),
  ).toEqual(["card", "cash", "gcash"]);
  expect(
    (await tenderPolicy(h.db, seeded))
      .map((/** @type {any} */ m) => m.code)
      .sort(),
  ).toEqual(["card", "cash"]);
  const series =
    await h.db`select s.prefix,s.vehicle_id,r.status,r.sample,r.document_type from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where r.org_unit_id=${bare}`;
  expect(series).toEqual([
    {
      prefix: "SAMPLE-STORE-BARE-STORE-SI",
      vehicle_id: null,
      status: "sample_not_filed",
      sample: true,
      document_type: "sales_invoice",
    },
  ]);
  expect(
    (
      await h.db`select count(*)::int n from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where r.org_unit_id=${seeded}`
    )[0].n,
  ).toBe(1);
  // Every row is marked as sample data, so the sample reset can find it.
  const [unmarked] =
    await h.db`select count(*)::int n from fiscal_tender_rules t where t.org_unit_id=${bare} and not exists(select 1 from sample_data_rows m where m.row_id=t.id::text)`;
  expect(unmarked.n).toBe(0);
  // seedFiscal reports the store pass and stays a no-op afterwards.
  expect((await seedFiscal(h.db)).stores).toEqual({ tenders: 0, series: 0 });
});

test("the refund series helper gives every sample store and sample vehicle one credit-memo series, once, and never touches an existing one", async () => {
  // a sample vehicle in the bare store's unit, and a hand-made credit-memo series the office already has for the other unit
  const vehicle = crypto.randomUUID();
  await h.db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values('sunpride',${bare},'CEBU','TRK-REFUND','Truck','truck',true,true,true,true,false)`;
  const [truck] =
    await h.db`select id from inventory_locations where code='TRK-REFUND'`;
  await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${vehicle},'sunpride',${bare},'V-REFUND','SAMPLE',${truck.id},${truck.id},'active','fixture')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('store-fiscal','vehicles',${vehicle},'vehicle-refund')`;
  const fresh = crypto.randomUUID(),
    office = crypto.randomUUID();
  await store(fresh, "STORE-FRESH");
  await store(office, "STORE-OFFICE");
  const [reg] =
    await h.db`insert into fiscal_registrations(org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample,tax_basis_points) values(${office},'SAMPLE','b','SAMPLE 000','a','credit_memo','sample_not_filed','2026-01-01',${admin},true,1200) returning id`;
  await h.db`insert into fiscal_series(registration_id,vehicle_id,prefix,first_serial,last_serial,next_allocate,effective_from) values(${reg.id},null,'OFFICE-CM',1,50,1,'2026-01-01')`;
  // the earlier test's seedFiscal already numbered `bare` and `seeded`; only the new store and the vehicle are new work

  const first = await seedRefundSeries(h.db);
  expect(first).toEqual({ stores: 1, vehicles: 1 });
  expect(await seedRefundSeries(h.db)).toEqual({ stores: 0, vehicles: 0 });
  const rows =
    await h.db`select s.prefix,s.vehicle_id,r.org_unit_id,r.status,r.sample from fiscal_series s join fiscal_registrations r on r.id=s.registration_id where r.document_type='credit_memo' order by s.prefix`;
  expect(
    rows.map((/** @type {any} */ r) => [r.prefix, r.vehicle_id, r.status]),
  ).toEqual([
    ["OFFICE-CM", null, "sample_not_filed"],
    ["SAMPLE-STORE-BARE-STORE-CM", null, "sample_not_filed"],
    ["SAMPLE-STORE-FRESH-STORE-CM", null, "sample_not_filed"],
    ["SAMPLE-STORE-SEEDED-STORE-CM", null, "sample_not_filed"],
    ["SAMPLE-V-REFUND-CM", vehicle, "sample_not_filed"],
  ]);
  // the office's own series is the unit's only credit-memo series: nothing was added beside it
  expect(
    rows.filter((/** @type {any} */ r) => r.org_unit_id === office),
  ).toHaveLength(1);
  // marked as sample data so the sample reset can find them
  const [unmarked] =
    await h.db`select count(*)::int n from fiscal_series s where s.prefix like 'SAMPLE-%-CM' and not exists(select 1 from sample_data_rows m where m.row_id=s.id::text)`;
  expect(unmarked.n).toBe(0);
  // seedFiscal runs both store passes and stays a no-op afterwards
  expect((await seedFiscal(h.db)).refundSeries).toEqual({
    stores: 0,
    vehicles: 0,
  });
});
