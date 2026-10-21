import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
} from "./harness.js";
import { startMock } from "../../sap-mock/src/server.js";
import { install } from "../src/domains/fiscal/index.js";
import { actorFor } from "../src/core/context.js";
import { payloadHash } from "../../../packages/integration-contracts/sap/v1/index.js";
import { enqueueSapPosting } from "../src/domains/van/settlement.js";
import { enqueueVanInvoice } from "../src/domains/integration/posting.js";
import {
  runOutbox,
  enqueueSapPosting as queueFinancial,
} from "../src/domains/integration/outbox.js";
import {
  saveRegistration,
  createSeries,
  allocateDocumentNumber,
  issueDocument,
} from "../src/domains/fiscal/series.js";
/** F-119: tiny source/adapter fixture, not a repeat checkout/settlement walkthrough. */
/** @type {any} */ let h;
/** @type {any} */ let mock;
/** @type {any} */ let seller;
/** @type {any} */ let document;
/** @type {any} */ let packet;
let approver = "";
const unit = crypto.randomUUID(),
  truck = crypto.randomUUID(),
  vehicle = crypto.randomUUID(),
  tripId = crypto.randomUUID(),
  saleId = crypto.randomUUID(),
  settlementId = crypto.randomUUID();
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  mock = startMock({
    path: h.filesDir + "/posting-sap.sqlite",
    port: 0,
    seed: false,
  });
  h.env.SAP_MODE = "mock";
  h.env.SAP_ORIGIN = mock.origin;
  const people = profileStore(h);
  h.setHooks({ unitInScope: async () => true });
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active',now()-interval '1 day')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('finish-posting','org_units',${unit},'SAMPLE')`;
  seller = await boundDevice(h, people, {
    app: "van-android",
    orgUnitId: unit,
    role: "super_admin",
  });
  const bossId = await createUser(
    h,
    "posting-approver@example.test",
    "test-only-posting-password",
  );
  const boss = {
    userId: bossId,
    email: "posting-approver@example.test",
    profile: people.set(bossId, {
      role: "super_admin",
      orgUnitId: unit,
      name: "SAMPLE approver",
    }),
  };
  for (const user of [seller, boss]) {
    const p = user.profile;
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${unit})`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','SAMPLE','SAMPLE')`;
  }
  approver = boss.profile.id;
  const actor = await actorFor(h.db, seller.userId),
    admin = await actorFor(h.db, bossId);
  if (!actor || !admin) throw new Error("SAMPLE actors missing");
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${truck},'sunpride',${unit},'SAMPLE','SAMPLE-VAN','SAMPLE van','truck',true,true,true,true,false)`;
  await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${vehicle},'sunpride',${unit},'SAMPLE','SAMPLE',${truck},${truck},'active','SAMPLE')`;
  await h.db`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,started_device_id,created_by) values(${tripId},'sunpride',${unit},'SAMPLE',${vehicle},${truck},${truck},'2026-10-21',${actor.profileId},${seller.userId},'reconciling',${seller.deviceId},'SAMPLE')`;
  const [trip] = await h.db`select * from van_trips where id=${tripId}`;
  const facts = {
    tripId,
    salesMinor: "1000",
    cashExpectedMinor: "1000",
    stock: [],
    documents: [],
    payments: [],
    returns: [],
  };
  packet = {
    sourceId: settlementId,
    kind: "van_settlement",
    facts: { ...facts, contentHash: payloadHash(facts), version: 1 },
  };
  await h.db`insert into van_settlements(id,trip_id,version,content_hash,facts,submitted_by,captured_at) values(${settlementId},${tripId},1,${payloadHash(facts)},${facts},${actor.profileId},now())`;
  const reg = await tx(h.db, (db) =>
    saveRegistration(db, admin, {
      orgUnitId: unit,
      entityName: "SAMPLE",
      branchName: "SAMPLE",
      tin: "SAMPLE",
      address: "SAMPLE",
      documentType: "sales_invoice",
      status: "sample_not_filed",
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  );
  const series = await tx(h.db, (db) =>
    createSeries(db, admin, {
      registrationId: reg.id,
      prefix: "SAMPLE-0574",
      firstSerial: "570",
      lastSerial: "579",
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  );
  const range = await tx(h.db, (db) =>
    allocateDocumentNumber(db, {
      actor,
      deviceId: seller.deviceId,
      seriesId: series.id,
      requestKey: crypto.randomUUID(),
      count: 1,
    }),
  );
  document = await tx(h.db, (db) =>
    issueDocument(db, {
      actor,
      deviceId: seller.deviceId,
      allocationId: range.allocationId,
      documentType: "sales_invoice",
      sourceType: "van_sale",
      sourceId: saleId,
      serial: "570",
      at: Date.now(),
      snapshot: { totalMinor: "1000" },
    }),
  );
  const receipt = {
    receiptNumber: document.document_number,
    fiscalDocumentId: document.id,
    totalMinor: 1000,
    soldAt: Date.now(),
    lines: [],
  };
  await h.db`insert into van_sales(id,trip_id,receipt_number,customer_code,total_centavos,receipt,captured_request) values(${saleId},${tripId},${document.document_number},'SAMPLE',1000,${receipt},${{ sample: true }})`;
  await tx(h.db, (db) => enqueueVanInvoice(db, trip, saleId));
}, 120000);
afterAll(async () => {
  mock?.stop();
  await h?.close();
});
test("F-119 independent approved settlement reaches the real mock with exact-once source acknowledgement", async () => {
  await expect(tx(h.db, (db) => enqueueSapPosting(db, packet))).rejects.toThrow(
    "independently approved",
  );
  expect((await h.db`select * from van_sap_requests`).length).toBe(0);
  await h.db`insert into van_settlement_decisions(settlement_id,decision,note,actor_profile_id) values(${settlementId},'approved','SAMPLE independent source',${approver})`;
  await h.db`update van_trips set status='closed',closed_at=now() where id=${tripId}`;
  await tx(h.db, (db) => enqueueSapPosting(db, packet));
  let [request] =
    await h.db`select * from van_sap_requests where source_id=${settlementId}`;
  expect(request.status).toBe("pending");
  expect(request.acknowledgement).toBeNull();
  expect(await runOutbox(h.db, { env: h.env })).toBe(1);
  expect(await runOutbox(h.db, { env: h.env })).toBe(1);
  [request] =
    await h.db`select * from van_sap_requests where source_id=${settlementId}`;
  expect(request.status).toBe("acknowledged");
  expect(request.acknowledgement.source).toBe("sample");
  const [event] =
    await h.db`select * from integration_events where id=${request.integration_event_id}`;
  expect(request.acknowledgement.reference).toBe(
    event.external_document_number,
  );
  expect(event.payload.document.facts.settlement.salesMinor).toBe("1000");
  expect(
    (
      await h.db`select sap_settlement_document_number from van_trips where id=${tripId}`
    )[0].sap_settlement_document_number,
  ).toBe(event.external_document_number);
  await tx(h.db, (db) => enqueueSapPosting(db, packet));
  expect(
    (
      await h.db`select id from integration_events where source_type='van_settlement'`
    ).length,
  ).toBe(1);
  expect(await runOutbox(h.db, { env: h.env })).toBe(0);
  const response = await h.fetch("/api/v1/fiscal/register", {
    headers: { Authorization: `Bearer ${seller.access}` },
  });
  expect(response.status).toBe(200);
  const register = await response.json();
  const [invoice] =
    await h.db`select external_document_number from integration_events where source_type='van_sale'`;
  expect(
    register.documents.find((/** @type {any} */ d) => d.id === document.id)
      .sap_posting,
  ).toEqual({
    status: "completed",
    source: "sample",
    reference: invoice.external_document_number,
  });
});
test("F-119 replay freezes settlement dependencies instead of adding a later source backfill", async () => {
  await h.db`insert into van_settlement_decisions(settlement_id,decision,note,actor_profile_id) values(${settlementId},'approved','SAMPLE independent source',${approver}) on conflict(settlement_id) do nothing`;
  await h.db`update van_trips set status='closed',closed_at=now() where id=${tripId}`;
  await tx(h.db, (db) => enqueueSapPosting(db, packet));
  const [original] =
    await h.db`select depends_on from integration_events where source_type='van_settlement'`;
  // A late canonical payment/backfill is a separate effect, not permission to rewrite this version.
  const paymentId = crypto.randomUUID();
  await tx(h.db, (db) =>
    queueFinancial(db, {
      kind: "payment",
      sourceType: "van_payment",
      sourceId: paymentId,
      orgUnitId: unit,
      document: {
        sourceType: "van_payment",
        sourceId: paymentId,
        customerCode: null,
        currency: "PHP",
        amountCentavos: 1,
        occurredAt: Date.now(),
        lines: [],
        facts: { tripId, sample: true },
      },
    }),
  );
  const replay = await tx(h.db, (db) => enqueueSapPosting(db, packet));
  expect(replay.duplicate).toBe(true);
  expect(replay.quarantined).toBe(false);
  expect(
    (
      await h.db`select depends_on from integration_events where source_type='van_settlement'`
    )[0].depends_on,
  ).toEqual(original.depends_on);
  expect((await h.db`select * from integration_conflicts`).length).toBe(0);
});
