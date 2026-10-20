import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  signedPost,
} from "./harness.js";
import { install as visits } from "../src/domains/visits/index.js";
import {
  install as retail,
  outletRetail,
  retailManifest,
} from "../src/domains/retail/index.js";
import { install as callflow } from "../src/domains/callflow/index.js";
import { manilaDate } from "../src/domains/visits/shared.js";
import { ensureCallflowSamples } from "../../../packages/db/seed/callflow.js";
import { MERCH_STEPS } from "../../../packages/db/seed/retail.js";
import { configuration } from "../src/domains/callflow/engine.js";
import { capture, custody, caseAction } from "../src/domains/retail/capture.js";
import { saveMaster } from "../src/domains/retail/masters.js";
import {
  accountWeek,
  visitScore,
  publishScore,
} from "../src/domains/retail/scoring.js";
import {
  traceBatch,
  confirmReceipt,
  openRecall,
  recallEvent,
  recallDetail,
} from "../src/domains/retail/recall.js";
import { previousWeek, installWeekly } from "../src/domains/retail/weekly.js";
import { seams } from "../src/domains/retail/common.js";
import { tx } from "@sunpride/db/client";
import { recordAudit } from "../src/domains/visits/merchandising.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { sampleMaster } from "../../sap-mock/src/sample.js";
/** @type {import('./harness.js').Harness} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
const DAY = 86400000,
  rootUnit = crypto.randomUUID();
beforeAll(async () => {
  h = await startHarness({ installers: [visits, callflow, retail] });
  profiles = profileStore(h);
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values (${rootUnit},'sunpride','SUNPRIDE','Sample national','national','active',${new Date(Date.now() - 30 * DAY)})`;
  await ensureCallflowSamples(h.db, Date.now() - DAY);
});
afterAll(async () => {
  await h?.close();
});
/** @param {any} [options] */
async function fixture(options = {}) {
  const now = Date.now(),
    day = manilaDate(now),
    early = new Date(now - 10 * 86400000),
    unit = options.unit ?? crypto.randomUUID();
  await h.db`insert into org_units (id,organization_id,code,name,type_code,status,effective_from,parent_id) values (${unit},'sunpride',${unit},'Cebu team','territory','active',${early},${rootUnit}) on conflict do nothing`;
  const d = await boundDevice(h, profiles, {
    app: options.app ?? "field-android",
    role: options.role ?? "sales",
    orgUnitId: unit,
  });
  const [position] =
    await h.db`insert into positions (organization_id,code,label,category,active) values ('sunpride',${crypto.randomUUID()},'Field specialist','field',true) returning id`;
  await h.db`insert into position_standards (organization_id,position_id,effective_from,productive_call_rule,source_ref) values ('sunpride',${position.id},${early},${options.rule ?? "any_listed_activity"},'TEST fixture')`;
  await h.db`insert into profiles (id,user_id,name,email,role,status,org_unit_id,position_id) values (${d.profile.id},${d.userId},'Field colleague',${d.email},${d.profile.role},'active',${unit},${position.id})`;
  const [employee] =
    await h.db`insert into employee_assignments (profile_id,org_unit_id,role,position_id,effective_from,actor_subject,reason)
    values (${d.profile.id},${unit},${d.profile.role},${position.id},${early},${d.userId},'Fixture') returning id`;
  const [territory] =
    await h.db`insert into territories (organization_id,code,name,status,effective_from,created_by) values ('sunpride',${crypto.randomUUID()},'Mandaue','active',${early},${d.userId}) returning id`;
  await h.db`insert into territory_ownerships (territory_id,org_unit_id,effective_from,actor_subject,reason) values (${territory.id},${unit},${early},${d.userId},'Fixture')`;
  await h.db`insert into territory_salespeople (territory_id,profile_id,effective_from,actor_subject,reason) values (${territory.id},${d.profile.id},${early},${d.userId},'Fixture')`;
  const [customer] =
    await h.db`insert into customers (code,name,channel,territory,credit_limit,active) values (${crypto.randomUUID()},'Test account','GT','Cebu',0,true) returning id`;
  const [outlet] =
    await h.db`insert into outlets (organization_id,code,name,status,custodian_org_unit_id,created_by) values ('sunpride',${crypto.randomUUID()},'Test store','active',${unit},${d.userId}) returning id`;
  await h.db`insert into outlet_assignments (outlet_id,territory_id,effective_from,actor_subject,reason) values (${outlet.id},${territory.id},${early},${d.userId},'Fixture')`;
  await h.db`insert into outlet_customer_links (outlet_id,customer_id,source,effective_from,actor_subject,reason) values (${outlet.id},${customer.id},'fixture',${early},${d.userId},'Fixture')`;
  await h.db`insert into outlet_pins (outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,verified_by,verified_at)
    values (${outlet.id},10.33,123.94,100,'fixture','verified',${early},'first',${early},'second',${early})`;
  const snapshot = {
    outletId: outlet.id,
    orgUnitId: unit,
    approvedAssigneeProfileId: d.profile.id,
    employeeAssignmentId: employee.id,
  };
  const [plan] =
    await h.db`insert into coverage_plans (organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,prepared_by,prepared_at,approval_signature,content_revision,created_by,updated_by)
    values ('sunpride',${d.profile.id},${day.slice(0, 7)},1,'monthly',${unit},${early},${new Date(now + DAY)},${early},${new Date(now + DAY)},'active',${d.userId},${early},'signed-fixture',1,${d.userId},${d.userId}) returning id`;
  const [slot] =
    await h.db`insert into coverage_plan_slots (slot_key,plan_id,assignee_profile_id,service_date,kind,outlet_id,intents,sequence,expected_duration_minutes,approved_snapshot,content_revision,updated_by)
    values ('one',${plan.id},${d.profile.id},${day},'outlet_visit',${outlet.id},array['merchandise'],1,30,${snapshot},1,${d.userId}) returning id`;
  const [planned] =
    await h.db`insert into planned_visits (generation_key,plan_id,plan_version,plan_slot_id,assignee_profile_id,outlet_id,service_date,status,approved_snapshot,intents,expected_duration_minutes,generated_at)
    values (${crypto.randomUUID()},${plan.id},1,${slot.id},${d.profile.id},${outlet.id},${day},'planned',${snapshot},array['merchandise'],30,${early}) returning id`;
  const [sku] =
    await h.db`insert into products (code,name,category,uom,unit_price,active,organization_id) values (${crypto.randomUUID()},'Test corned beef','Canned','PC',0,true,'sunpride') returning id`;
  return {
    d,
    unit,
    day,
    now,
    outlet: outlet.id,
    customer: customer.id,
    planned: planned.id,
    plan: plan.id,
    slot: slot.id,
    sku: sku.id,
    territory: territory.id,
    fix: {
      latitude: 10.33,
      longitude: 123.94,
      accuracyMeters: 5,
      fixTime: now,
      provider: "gps",
      mockSignal: false,
    },
  };
}
/** @param {any} f @param {any} [body] @param {string} [role] */
function ctx(f, body = {}, role = "sales") {
  return {
    db: h.db,
    actor: {
      subject: f.d.userId,
      userId: f.d.userId,
      profileId: f.d.profile.id,
      orgUnitId: f.unit,
      role,
      name: "Test",
    },
    device: { id: f.d.deviceId },
    app: "field-android",
    body,
    payload: body,
    now: Date.now(),
    op: { clientOpId: crypto.randomUUID() },
    change: async () => {},
    publish: () => {},
    enqueue: async () => {},
  };
}
/** @param {string} kind @param {any} data @param {number} [at] @param {string} [klass] */
async function master(kind, data, at = Date.now() - DAY, klass = "*") {
  const [m] =
    await h.db`insert into retail_master_versions(kind,code,version,label,outlet_class,effective_from,data,source,actor_subject) values(${kind},${crypto.randomUUID()},1,${"Test " + kind},${klass},${new Date(at)},${data},'sample','fixture') returning *`;
  return m;
}
/** @param {any} f @param {string} [visitId] */
async function photo(f, visitId = f.visit) {
  const digest = new Bun.CryptoHasher("sha256")
    .update(crypto.randomUUID())
    .digest("hex");
  const [file] =
    await h.db`insert into files(owner_id,purpose,sha256,mime,size,status,stored_at,created_by) values(${visitId},'visit-evidence',${digest},'image/jpeg',100,'stored',now(),${f.d.userId}) returning id`;
  const [e] =
    await h.db`insert into field_evidence_files(organization_id,org_unit_id,storage_id,visit_id,owner_profile_id,outlet_id,mime,size_bytes,checksum,captured_at,photo_type,uploaded_at,status) values('sunpride',${f.unit},${file.id},${visitId},${f.d.profile.id},${f.outlet},'image/jpeg',100,${digest},${new Date(f.now)},'shelf_display',now(),'pending') returning id`;
  return e.id;
}
/** @param {any} [options] */
async function started(options = {}) {
  const f = await fixture(options),
    config = await configuration(
      h.db,
      "field_selling",
      { id: f.outlet },
      f.now,
    );
  const op = {
    clientOpId: crypto.randomUUID(),
    opType: "visit.checkIn",
    clientTime: f.now,
    dependsOn: [],
    payload: {
      clientVisitId: crypto.randomUUID(),
      plannedVisitId: f.planned,
      outletId: f.outlet,
      serviceDate: f.day,
      intents: ["merchandise"],
      deviceTime: f.now,
      location: f.fix,
      flowDefinitionId: config.definition.id,
    },
  };
  const r = await signedPost(h, f.d, "/api/sync/push", {
    version: 2,
    deviceId: f.d.deviceId,
    scopeId: f.unit,
    operations: [op],
  });
  expect(r.body.results[0].status).toBe("applied");
  return { ...f, visit: r.body.results[0].ack.entityId };
}
/** @param {any} f @param {string} kind @param {any} data */
async function record(f, kind, data) {
  const payload = {
    visitId: f.visit,
    requestKey: crypto.randomUUID(),
    deviceTime: Date.now(),
    kind,
    data,
  };
  const op = {
    clientOpId: crypto.randomUUID(),
    opType: "retail.capture",
    clientTime: payload.deviceTime,
    dependsOn: [],
    payload,
  };
  const response = await signedPost(h, f.d, "/api/sync/push", {
    version: 2,
    deviceId: f.d.deviceId,
    scopeId: f.unit,
    operations: [op],
  });
  return { result: response.body.results[0], payload, op };
}
/** @param {any} f */
async function freezer(f) {
  const policy = await master("cold_policy", {
    type: "freezer",
    minTemperatureDeciC: -250,
    maxTemperatureDeciC: -180,
    minOwnSharePercent: 90,
    followupHours: 4,
  });
  const equipment = await master("equipment", {
    serial: crypto.randomUUID(),
    model: "Sample freezer",
    sapFixedAssetId: crypto.randomUUID(),
    custodian: "Sample store",
    agreement: "Own products",
    location: "Cebu",
    type: "freezer",
    outletId: f.outlet,
    deployedAt: f.now - DAY,
    policyVersionId: policy.id,
  });
  return {
    policy,
    equipment,
    data: {
      equipmentVersionId: equipment.id,
      scannedSerial: equipment.data.serial,
      temperatureDeciC: -190,
      ownSharePercent: 95,
      measuredAt: f.now,
      evidenceIds: [await photo(f)],
    },
  };
}

test("F-314 F-315 signed freezer audit freezes SAP asset, purity and temperature; exact replay creates no second breach", async () => {
  const f = await started(),
    a = await freezer(f);
  const first = await record(f, "freezer", {
    ...a.data,
    temperatureDeciC: -100,
    ownSharePercent: 60,
  });
  expect(first.result.status).toBe("applied");
  const [saved] =
    await h.db`select * from retail_execution_audits where id=${first.result.ack.entityId}`;
  expect(saved.facts.breaches).toEqual(["purity", "temperature"]);
  expect(Number(saved.component_score)).toBe(0);
  expect(saved.facts.equipment.sapFixedAssetId).toBe(
    a.equipment.data.sapFixedAssetId,
  );
  const replay = await signedPost(h, f.d, "/api/sync/push", {
    version: 2,
    deviceId: f.d.deviceId,
    scopeId: f.unit,
    operations: [first.op],
  });
  expect(replay.body.results[0].status).toBe("duplicate");
  expect(
    (await h.db`select * from retail_action_cases where audit_id=${saved.id}`)
      .length,
  ).toBe(1);
  const [p] =
    await h.db`select * from retail_master_versions where id=${a.policy.id}`;
  expect(p.data.minOwnSharePercent).toBe(90);
});
test("F-315 wrong serial, foreign photo, missing photo and stale temperature fail with no observations", async () => {
  const f = await started(),
    a = await freezer(f),
    other = await started();
  const foreign = await photo(other);
  for (const data of [
    { ...a.data, scannedSerial: "wrong" },
    { ...a.data, evidenceIds: [] },
    { ...a.data, evidenceIds: [foreign] },
    { ...a.data, measuredAt: f.now - 3600001 },
  ])
    expect((await record(f, "freezer", data)).result.status).toBe("rejected");
  expect(
    (
      await h.db`select * from retail_execution_audits where visit_id=${f.visit}`
    ).length,
  ).toBe(0);
});
test("F-315 audit cannot bypass current outlet authorization after transfer, even under a fresh replay key", async () => {
  const f = await started(),
    a = await freezer(f),
    r = await record(f, "freezer", a.data);
  expect(r.result.status).toBe("applied");
  await h.db`update territory_ownerships set org_unit_id=${rootUnit} where territory_id=${f.territory}`;
  await expect(
    tx(h.db, (t) => capture({ ...ctx(f, r.payload), db: t })),
  ).rejects.toThrow();
});
test("F-311 applied class planogram freezes positions, facings and numeric share; missing target is refused", async () => {
  const f = await started(),
    klass = crypto.randomUUID();
  await h.db`update outlets set classification=${klass} where id=${f.outlet}`;
  const target = await master(
    "planogram",
    {
      lines: [{ productId: f.sku, facings: 4, position: "Shelf A" }],
      targetSharePercent: 40,
    },
    f.now - DAY,
    klass,
  );
  const data = {
    masterVersionId: target.id,
    lines: [{ productId: f.sku, facings: 2, position: "Shelf A" }],
    ownFacings: 2,
    totalFacings: 10,
    evidenceIds: [await photo(f)],
  };
  expect(
    (await record(f, "planogram", { ...data, lines: [] })).result.status,
  ).toBe("rejected");
  const r = await record(f, "planogram", data);
  expect(r.result.status).toBe("applied");
  const [a] =
    await h.db`select * from retail_execution_audits where id=${r.result.ack.entityId}`;
  expect(Number(a.component_score)).toBe(50);
  expect(a.facts.sharePercent).toBe(20);
  expect(a.facts.target.lines[0].facings).toBe(4);
});
test("F-320 shelf expiry uses Manila date and SKU threshold; pullout waits for acknowledged SAP handoff", async () => {
  const f = await started(),
    policy = await master("expiry_policy", {
      productId: f.sku,
      nearExpiryDays: 30,
      action: "markdown",
    });
  const expiry = new Date(Date.parse(f.day) + 30 * DAY)
      .toISOString()
      .slice(0, 10),
    data = {
      lines: [
        {
          productId: f.sku,
          batch: "BATCH-X",
          expiryDate: expiry,
          quantityBase: 12,
        },
      ],
      evidenceIds: [await photo(f)],
    };
  const r = await record(f, "expiry", data);
  expect(r.result.status).toBe("applied");
  const [a] =
    await h.db`select * from retail_action_cases where audit_id=${r.result.ack.entityId}`;
  expect(a.kind).toBe("markdown");
  expect(a.facts.daysRemaining).toBe(30);
  expect(a.facts.policyVersionId).toBe(policy.id);
  const manager = ctx(
    f,
    { caseId: a.id, action: "approve", note: "Review" },
    "super_admin",
  );
  manager.actor.profileId = crypto.randomUUID();
  const result = await tx(h.db, (t) => caseAction({ ...manager, db: t }));
  expect(result.status).toBe("awaiting_sap");
  await expect(
    tx(h.db, (t) =>
      caseAction({
        ...manager,
        db: t,
        body: {
          caseId: a.id,
          action: "resolve",
          note: "Done",
          reference: "Not an acknowledgement",
        },
      }),
    ),
  ).rejects.toThrow();
});
test("F-320 duplicate shelf batch lines and impossible date fail atomically", async () => {
  const f = await started();
  await master("expiry_policy", {
    productId: f.sku,
    nearExpiryDays: 30,
    action: "pullout",
  });
  const l = {
    productId: f.sku,
    batch: "X",
    expiryDate: f.day,
    quantityBase: 3,
  };
  expect(
    (
      await record(f, "expiry", {
        lines: [l, l],
        evidenceIds: [await photo(f)],
      })
    ).result.status,
  ).toBe("rejected");
  expect(
    (
      await record(f, "expiry", {
        lines: [{ ...l, expiryDate: "2026-02-30" }],
        evidenceIds: [await photo(f)],
      })
    ).result.status,
  ).toBe("rejected");
  expect(
    (await h.db`select * from retail_action_cases where outlet_id=${f.outlet}`)
      .length,
  ).toBe(0);
});
test("F-317 F-321 structured competitor shelf share and field incidents remain separate from QA", async () => {
  const f = await started(),
    photoId = await photo(f),
    cat = await master("incident_category", { severity: "high", slaHours: 4 });
  const comp = await record(f, "competitor", {
    type: "shelf_share",
    brand: "Sample rival",
    sku: "Sample SKU",
    note: "Observed shelf",
    sharePercent: 35,
    evidenceIds: [photoId],
  });
  expect(comp.result.status).toBe("applied");
  const incident = await record(f, "issue_log", {
    categoryVersionId: cat.id,
    note: "Freezer disconnected",
    geo: {
      latitude: 10.33,
      longitude: 123.94,
      accuracyMeters: 5,
      fixTime: f.now,
    },
    evidenceIds: [photoId],
  });
  expect(incident.result.status).toBe("applied");
  const [c] =
    await h.db`select * from retail_action_cases where audit_id=${incident.result.ack.entityId}`;
  expect(c.kind).toBe("incident");
  expect(c.facts.geo.latitude).toBe(10.33);
  const noIssues = await h.db`select * from issues`;
  expect(noIssues.length).toBe(0);
});
test("F-313 POSM issue deploy audit and independently approved write-off preserve custody history", async () => {
  const f = await started(),
    m = await master("posm", { material: "Header", auditEveryDays: 7 }),
    unit = crypto.randomUUID(),
    base = {
      unitCode: unit,
      materialVersionId: m.id,
      custodianProfileId: f.d.profile.id,
      reason: "Test",
      requestKey: crypto.randomUUID(),
    };
  const run = (/** @type {any} */ b, role = "super_admin") =>
    tx(h.db, (t) => custody({ ...ctx(f, b, role), db: t }));
  await run({ ...base, kind: "issue" });
  await run({
    ...base,
    requestKey: crypto.randomUUID(),
    kind: "deploy",
    outletId: f.outlet,
    visitId: f.visit,
    photoId: await photo(f),
  });
  expect(
    (
      await record(f, "posm", {
        unitCode: unit,
        present: true,
        condition: "good",
        evidenceIds: [await photo(f)],
      })
    ).result.status,
  ).toBe("applied");
  await run({
    ...base,
    requestKey: crypto.randomUUID(),
    kind: "write_off_request",
  });
  await expect(
    run({ ...base, requestKey: crypto.randomUUID(), kind: "write_off" }),
  ).rejects.toThrow();
  const c = ctx(
    f,
    { ...base, requestKey: crypto.randomUUID(), kind: "write_off" },
    "super_admin",
  );
  c.actor.subject = "independent-supervisor";
  await tx(h.db, (t) => custody({ ...c, db: t }));
  expect(
    (await h.db`select * from posm_custody_events where unit_code=${unit}`)
      .length,
  ).toBe(4);
});
test("F-318 TPM scope follows its exact include/exclude schema; absent facts deny restricted campaigns", () => {
  expect(
    seams.campaignEligible(
      { outletId: { include: ["one"], exclude: ["two"] } },
      { outletId: "one" },
    ),
  ).toBe(true);
  expect(
    seams.campaignEligible(
      { outletId: { include: ["one"], exclude: ["one"] } },
      { outletId: "one" },
    ),
  ).toBe(false);
  expect(
    seams.campaignEligible(
      { distributorId: { include: ["partner"] } },
      { outletId: "one" },
    ),
  ).toBe(false);
  expect(
    seams.campaignEligible({ outletIds: ["one"] }, { outletId: "one" }),
  ).toBe(false);
});
test("F-316 missing mandatory evidence remains incomplete rather than zero or perfect", async () => {
  const f = await started(),
    p = await master("scorecard", {
      components: [
        "availability",
        "planogram",
        "posm",
        "price",
        "freezer",
        "promotion",
      ].map((key, i) => ({
        key,
        weight: i === 0 ? 25 : 15,
        allowNotApplicable: true,
      })),
      targetPercent: 90,
    });
  const [v] = await h.db`select * from visit_executions where id=${f.visit}`;
  const r = await visitScore(ctx(f), v, p);
  expect(r.status).toBe("incomplete");
  expect(r.score).toBeNull();
  expect(r.missing).toContain("availability");
  expect(r.missing).toContain("price");
});
test("F-314 new equipment masters are prospective editable versions, never overwrite old service facts", async () => {
  const f = await started(),
    a = await freezer(f),
    c = ctx(f, {}, "super_admin");
  c.body = {
    requestKey: crypto.randomUUID(),
    kind: "equipment",
    code: a.equipment.code,
    label: "Freezer revised",
    effectiveFrom: c.now + 5000,
    data: { ...a.equipment.data, custodian: "New custodian" },
  };
  const r = await tx(h.db, (t) => saveMaster({ ...c, db: t }));
  expect(r.version).toBe(2);
  expect(
    (
      await h.db`select data from retail_master_versions where id=${a.equipment.id}`
    )[0].data.custodian,
  ).toBe("Sample store");
});
test("F-614 batch to received outlets, notice acknowledgement and bounded recovery preserve source provenance", async () => {
  const f = await started(),
    [l] =
      await h.db`insert into inventory_lots(organization_id,product_id,lot_number,normalized_lot_number,source_type,received_at,quality_status) values('sunpride',${f.sku},'RECALL-X','RECALL-X','test',now(),'released') returning id`;
  const c = ctx(
    f,
    {
      outletId: f.outlet,
      lotId: l.id,
      quantityBase: 24,
      sourceKey: crypto.randomUUID(),
      sourceVersion: "SAP-test-1",
      receivedAt: f.now,
    },
    "super_admin",
  );
  const r = await tx(h.db, (t) => confirmReceipt({ ...c, db: t }));
  expect(r.id).toBeTruthy();
  const trace = await traceBatch(c, l.id);
  expect(trace.affectedOutlets).toBe(1);
  expect(trace.rows[0].certainty).toBe("confirmed_receipt");
  const opened = await tx(h.db, (t) =>
    openRecall({ ...c, db: t, body: { lotId: l.id, reason: "Sample recall" } }),
  );
  for (const kind of ["notice", "acknowledge", "recovery"])
    await tx(h.db, (t) =>
      recallEvent({
        ...c,
        db: t,
        body: {
          recallId: opened.id,
          outletId: f.outlet,
          kind,
          quantityBase: kind === "recovery" ? 10 : 0,
          reference: `Test ${kind}`,
        },
      }),
    );
  const detail = await recallDetail(c, opened.id);
  expect(detail.outlets[0].remainingConfirmedBase).toBe(14);
  expect(detail.outlets[0].acknowledged).toBe(true);
  await expect(
    tx(h.db, (t) =>
      recallEvent({
        ...c,
        db: t,
        body: {
          recallId: opened.id,
          outletId: f.outlet,
          kind: "recovery",
          quantityBase: 15,
          reference: "Too much",
        },
      }),
    ),
  ).rejects.toThrow();
});
test("F-310 merch configuration is the existing engine; unsupported earlier steps prevent later facts", async () => {
  const f = await started(),
    at = f.now - DAY;
  const [definition] =
    await h.db`insert into call_flow_definitions(channel_profile,version,label,steps,effective_from,published_by,source) values(${crypto.randomUUID()},1,'Test merchandising',${MERCH_STEPS.map(([adapter, label, required]) => ({ key: adapter, adapter, label, required, condition: "always" }))},${new Date(at)},'fixture','sample') returning *`;
  await h.db`update call_executions set definition_snapshot=${{ id: definition.id, steps: definition.steps, channelProfile: "merchandiser" }} where visit_id=${f.visit}`;
  const result = await record(f, "competitor", {
    noneObserved: true,
    evidenceIds: [],
  });
  expect(result.result.status).toBe("rejected");
  const legacy = await signedPost(h, f.d, "/api/sync/push", {
    version: 2,
    deviceId: f.d.deviceId,
    scopeId: f.unit,
    operations: [
      {
        clientOpId: crypto.randomUUID(),
        opType: "visit.activity",
        clientTime: Date.now(),
        dependsOn: [],
        payload: {
          visitId: f.visit,
          deviceTime: Date.now(),
          activity: {
            kind: "promotion",
            programRef: "Claimed done",
            finding: "executed",
          },
        },
      },
    ],
  });
  expect(legacy.body.results[0].status).toBe("rejected");
  expect(legacy.body.results[0].code).toBe("unsupported_operation");
  expect(
    (
      await h.db`select * from visit_activities where visit_id=${f.visit} and activity_kind='promotion'`
    ).length,
  ).toBe(0);
  expect(
    (
      await h.db`select * from retail_execution_audits where visit_id=${f.visit}`
    ).length,
  ).toBe(0);
});
test("F-315 stored observations are append-only, not editable score submissions", async () => {
  const f = await started(),
    a = await freezer(f),
    r = await record(f, "freezer", a.data);
  expect(r.result.status).toBe("applied");
  await expect(
    (async () => {
      await h.db`update retail_execution_audits set component_score=100 where id=${r.result.ack.entityId}`;
    })(),
  ).rejects.toThrow("immutable");
});
test("F-316 weighted scores explain all six components and distinguish unavailable TPM from genuine not-applicable", async () => {
  const f = await started(),
    klass = crypto.randomUUID(),
    channel = "sample-" + crypto.randomUUID();
  await h.db`update outlets set classification=${klass},channel=${channel} where id=${f.outlet}`;
  const p = await master(
    "scorecard",
    {
      components: [
        ["availability", 25],
        ["planogram", 20],
        ["posm", 10],
        ["price", 15],
        ["freezer", 20],
        ["promotion", 10],
      ].map(([key, weight]) => ({
        key,
        weight,
        allowNotApplicable: key === "promotion",
      })),
      targetPercent: 90,
    },
    f.now - DAY,
    klass,
  );
  const a = await freezer(f);
  expect((await record(f, "freezer", a.data)).result.status).toBe("applied");
  const target = await master(
    "planogram",
    {
      lines: [{ productId: f.sku, facings: 4, position: "A" }],
      targetSharePercent: 40,
    },
    f.now - DAY,
    klass,
  );
  expect(
    (
      await record(f, "planogram", {
        masterVersionId: target.id,
        lines: [{ productId: f.sku, facings: 2, position: "A" }],
        ownFacings: 2,
        totalFacings: 10,
        evidenceIds: [await photo(f)],
      })
    ).result.status,
  ).toBe("applied");
  const material = await master("posm", {
      material: "Header",
      auditEveryDays: 7,
    }),
    unit = crypto.randomUUID();
  await tx(h.db, (t) =>
    custody({
      ...ctx(
        f,
        {
          unitCode: unit,
          kind: "issue",
          materialVersionId: material.id,
          custodianProfileId: f.d.profile.id,
          requestKey: crypto.randomUUID(),
          reason: "Sample",
        },
        "super_admin",
      ),
      db: t,
    }),
  );
  const deployment = await record(f, "posm", {
    unitCode: unit,
    action: "deploy",
    present: true,
    condition: "good",
    evidenceIds: [await photo(f)],
  });
  expect(deployment.result.status).toBe("applied");
  const [deployed] =
    await h.db`select * from posm_custody_events where unit_code=${unit} and kind='deploy'`;
  expect(deployed.outlet_id).toBe(f.outlet);
  expect(deployed.photo_id).toBeTruthy();
  await h.db`insert into outlet_assortments(organization_id,outlet_id,effective_from,source_ref,actor_subject) values('sunpride',${f.outlet},${new Date(f.now - DAY)},'Test assortment','fixture') returning id`.then(
    async (rows) => {
      await h.db`insert into outlet_assortment_products(outlet_assortment_id,ordinal,product_id) values(${rows[0].id},0,${f.sku})`;
    },
  );
  await tx(h.db, (t) =>
    recordAudit({
      ...ctx(f, {
        visitId: f.visit,
        clientAuditId: crypto.randomUUID(),
        deviceTime: Date.now(),
        availability: [{ productId: f.sku, status: "available", facings: 2 }],
        compliance: [],
        competitors: [],
        evidenceIds: [],
      }),
      db: t,
    }),
  );
  const op = {
    clientOpId: crypto.randomUUID(),
    opType: "visit.activity",
    clientTime: Date.now(),
    dependsOn: [],
    payload: {
      visitId: f.visit,
      deviceTime: Date.now(),
      activity: {
        kind: "price_check",
        productId: f.sku,
        observedPriceMinor: 10000,
        currency: "PHP",
        compliant: false,
      },
    },
  };
  const sent = await signedPost(h, f.d, "/api/sync/push", {
    version: 2,
    deviceId: f.d.deviceId,
    scopeId: f.unit,
    operations: [op],
  });
  expect(sent.body.results[0].status).toBe("applied");
  const [v] = await h.db`select * from visit_executions where id=${f.visit}`;
  const campaignsOwner = seams.campaigns;
  seams.campaigns = async () => null; // Explicit unavailable feed, not absence of a merged table.
  try {
    expect((await visitScore(ctx(f), v, p)).missing).toContain("promotion");
  } finally {
    seams.campaigns = campaignsOwner;
  }
  const [priceList] =
    await h.db`insert into price_lists(organization_id,code,name,channel_key,currency,status,source,effective_from) values('sunpride',${crypto.randomUUID()},'Sample governed shelf price',${channel},'PHP','active','sample',${new Date(f.now - DAY)}) returning id`;
  await h.db`insert into price_list_lines(organization_id,price_list_id,product_id,uom,unit_price_minor,effective_from) values('sunpride',${priceList.id},${f.sku},'PC',10000,${new Date(f.now - DAY)})`;
  const [sku] = await h.db`select code from products where id=${f.sku}`;
  await ingestMaster(
    h.db,
    sampleMaster("condition", `F316:${f.sku}`, {
      productCode: sku.code,
      uom: "PC",
      customerCode: null,
      channelKey: channel,
      unitPriceCentavos: 10000,
      currency: "PHP",
      taxCode: "SAMPLE",
      taxBasisPoints: 0,
      taxInclusive: true,
      priceListCode: "SA2-SAP-CONTROL",
      precedence: 99,
    }),
  );
  const original = seams.campaigns;
  seams.campaigns = async () => [];
  try {
    const score = await visitScore(ctx(f), v, p);
    expect(score.status).toBe("complete");
    expect(score.score).toBe(88.89);
    await h.db`update outlets set classification='future-class',channel='future-channel' where id=${f.outlet}`;
    const retained = await accountWeek(
      ctx(f),
      f.customer,
      previousWeek(Date.now() + 7 * DAY),
    );
    expect(retained.score).toBe(88.89);
    expect(
      "policyVersionId" in retained.branches[0] &&
        retained.branches[0].policyVersionId,
    ).toBe(p.id);
    expect(
      score.components.find((/** @type {any} */ x) => x.key === "promotion")
        .status,
    ).toBe("not_applicable");
    expect(
      score.components.find((/** @type {any} */ x) => x.key === "price").value
        .score,
    ).toBe(100);
    const changed = structuredClone(op);
    changed.clientOpId = crypto.randomUUID();
    changed.payload.deviceTime = Date.now();
    changed.payload.activity.observedPriceMinor = 10001;
    changed.payload.activity.compliant = true;
    expect(
      (
        await signedPost(h, f.d, "/api/sync/push", {
          version: 2,
          deviceId: f.d.deviceId,
          scopeId: f.unit,
          operations: [changed],
        })
      ).body.results[0].status,
    ).toBe("applied");
    expect(
      (await visitScore(ctx(f), v, p)).components.find(
        (/** @type {any} */ x) => x.key === "price",
      ).value.score,
    ).toBe(0);
  } finally {
    seams.campaigns = original;
  }
});
test("F-316 canonical source ownership prevents another salesperson reading a colleague score", async () => {
  const f = await started(),
    other = await fixture({ unit: f.unit }),
    p = await master(
      "scorecard",
      {
        components: [
          { key: "availability", weight: 100, allowNotApplicable: false },
        ],
        targetPercent: 90,
      },
      f.now - DAY,
      crypto.randomUUID(),
    );
  const [v] = await h.db`select * from visit_executions where id=${f.visit}`;
  await expect(visitScore(ctx(other), v, p)).rejects.toThrow();
});
test("F-311 F-314 immutable master history permits interval closure but refuses target edits", async () => {
  const m = await master("cold_policy", {
    type: "freezer",
    minTemperatureDeciC: -250,
    maxTemperatureDeciC: -180,
    minOwnSharePercent: 90,
    followupHours: 4,
  });
  await expect(
    (async () => {
      await h.db`update retail_master_versions set data=${{ ...m.data, minOwnSharePercent: 0 }} where id=${m.id}`;
    })(),
  ).rejects.toThrow();
  await h.db`update retail_master_versions set effective_to=${new Date(Date.now() + DAY)} where id=${m.id}`;
  expect(
    (await h.db`select data from retail_master_versions where id=${m.id}`)[0]
      .data.minOwnSharePercent,
  ).toBe(90);
});

test("F-315 a deployed agreement keeps its pinned policy after general policy closure", async () => {
  const f = await started(),
    a = await freezer(f);
  await h.db`update retail_master_versions set effective_to=${new Date(f.now - 100)} where id=${a.policy.id}`;
  const snapshot = await outletRetail(ctx(f), { id: f.outlet });
  expect(
    snapshot.masters.some((/** @type {any} */ m) => m.id === a.policy.id),
  ).toBe(true);
  const r = await record(f, "freezer", a.data);
  expect(r.result.status).toBe("applied");
  const [saved] =
    await h.db`select * from retail_execution_audits where id=${r.result.ack.entityId}`;
  expect(saved.facts.policyVersionId).toBe(a.policy.id);
  expect(saved.facts.policy.minOwnSharePercent).toBe(90);
  expect(saved.payload_hash).toMatch(/^[a-f0-9]{64}$/);
});
test("F-311 overlapping class publications are refused before poisoning a future bootstrap", async () => {
  const f = await fixture(),
    klass = crypto.randomUUID(),
    m = await master(
      "planogram",
      {
        lines: [{ productId: f.sku, facings: 3, position: "A" }],
        targetSharePercent: 50,
      },
      f.now - DAY,
      klass,
    );
  const c = ctx(
    f,
    {
      kind: "planogram",
      code: crypto.randomUUID(),
      label: "Duplicate class plan",
      outletClass: klass,
      effectiveFrom: Date.now() + 10000,
      data: m.data,
    },
    "super_admin",
  );
  await expect(tx(h.db, (t) => saveMaster({ ...c, db: t }))).rejects.toThrow(
    "overlapping",
  );
  expect(
    (
      await h.db`select * from retail_master_versions where kind='planogram' and outlet_class=${klass}`
    ).length,
  ).toBe(1);
});
test("F-313 custody assignment uses current employee history instead of the stale profile unit", async () => {
  const f = await fixture(),
    person = await fixture({ unit: f.unit }),
    foreign = await fixture(),
    material = await master("posm", { material: "Board", auditEveryDays: 7 });
  const body = {
    unitCode: crypto.randomUUID(),
    kind: "issue",
    materialVersionId: material.id,
    custodianProfileId: person.d.profile.id,
    requestKey: crypto.randomUUID(),
    reason: "Sample custody",
  };
  await tx(h.db, (t) => custody({ ...ctx(f, body, "operations"), db: t }));
  const [assignment] =
    await h.db`select * from employee_assignments where profile_id=${person.d.profile.id} and effective_to is null`;
  const at = new Date(Date.now() - 100);
  await h.db`update employee_assignments set effective_to=${at} where id=${assignment.id}`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,position_id,effective_from,actor_subject,reason) values(${person.d.profile.id},${foreign.unit},'sales',${assignment.position_id},${at},'fixture','Transfer')`;
  const next = {
    ...body,
    unitCode: crypto.randomUUID(),
    requestKey: crypto.randomUUID(),
  };
  await expect(
    tx(h.db, (t) => custody({ ...ctx(f, next, "operations"), db: t })),
  ).rejects.toThrow();
  expect(
    (
      await h.db`select * from posm_custody_events where unit_code=${next.unitCode}`
    ).length,
  ).toBe(0);
  expect(
    (
      await h.db`select org_unit_id from profiles where id=${person.d.profile.id}`
    )[0].org_unit_id,
  ).toBe(f.unit);
});
test("F-614 scoped traces never expose another received outlet or its quantities", async () => {
  const f = await fixture(),
    other = await fixture(),
    [lot] =
      await h.db`insert into inventory_lots(organization_id,product_id,lot_number,normalized_lot_number,source_type,received_at,quality_status) values('sunpride',${f.sku},${crypto.randomUUID()},${crypto.randomUUID()},'test',now(),'released') returning id`;
  for (const [person, qty] of /** @type {[any,number][]} */ ([
    [f, 12],
    [other, 999],
  ]))
    await tx(h.db, (t) =>
      confirmReceipt({
        ...ctx(
          person,
          {
            outletId: person.outlet,
            lotId: lot.id,
            quantityBase: qty,
            sourceKey: crypto.randomUUID(),
            sourceVersion: "Sample SAP-v1",
            receivedAt: person.now,
          },
          "super_admin",
        ),
        db: t,
      }),
    );
  const visible = await traceBatch(ctx(f), lot.id);
  expect(visible.affectedOutlets).toBe(1);
  expect(visible.rows.length).toBe(1);
  expect(Number(visible.rows[0].quantity_base)).toBe(12);
  expect(visible.backwardGenealogy).toEqual([]);
  const none = await fixture();
  await expect(traceBatch(ctx(none), lot.id)).rejects.toThrow("in your scope");
});
test("F-318 unknown excluded dimensions cannot certify a restricted campaign as eligible", () => {
  expect(
    seams.campaignEligible(
      { distributorId: { exclude: ["foreign"] } },
      { outletId: "one" },
    ),
  ).toBe(false);
  expect(
    seams.campaignEligible(
      { geographyKey: { include: [], exclude: [] } },
      { outletId: "one" },
    ),
  ).toBe(true);
});
test("F-316 scheduled weekly publication uses durable per-account jobs and does not duplicate unchanged facts", async () => {
  const f = await fixture();
  /** @type {any} */ let schedule;
  /** @type {any} */ let worker;
  installWeekly({
    scheduler: {
      daily: (
        /** @type {string} */ time,
        /** @type {string} */ zone,
        /** @type {string} */ name,
        /** @type {any} */ fn,
      ) => {
        schedule = { time, zone, name, fn };
      },
    },
    registerJob: (/** @type {string} */ kind, /** @type {any} */ fn) => {
      expect(kind).toBe("retail.weekly.publish");
      worker = fn;
    },
    recordChange: () => {},
    publish: () => {},
  });
  expect(schedule.time).toBe("00:15");
  expect(schedule.zone).toBe("Asia/Manila");
  expect(previousWeek(Date.parse("2026-10-18T17:00:00Z"))).toBe("2026-10-12");
  await schedule.fn({ db: h.db });
  const jobs =
    await h.db`select * from jobs where kind='retail.weekly.publish' and payload->>'customerId'=${f.customer}`;
  expect(jobs.length).toBe(1);
  await worker({ db: h.db, payload: jobs[0].payload });
  await worker({ db: h.db, payload: jobs[0].payload });
  const rows =
    await h.db`select * from perfect_store_publications where customer_id=${f.customer}`;
  expect(rows.length).toBe(1);
  expect(rows[0].snapshot.status).toBe("incomplete");
  expect(rows[0].snapshot.score).toBeNull();
  expect(rows[0].actor_subject).toBe("system:retail-weekly");
});
test("F-316 office workspace accepts a blank all-stores filter without casting it as a UUID", async () => {
  const f = await fixture({ role: "super_admin" });
  for (const query of ["", "?outletId=", `?outletId=${f.outlet}`]) {
    const response = await h.fetch("/api/v1/retail/workspace" + query, {
      headers: { authorization: `Bearer ${f.d.access}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.audits)).toBe(true);
    expect(Array.isArray(body.incompleteSections)).toBe(true);
  }
});
test("F-311 native targets carry readable SKU names and layout history retains every referenced product", async () => {
  const f = await fixture(),
    klass = crypto.randomUUID();
  const [second] =
    await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id) values(${crypto.randomUUID()},'Second shelf product','Frozen','PC',0,true,'sunpride') returning id`;
  await h.db`update outlets set classification=${klass} where id=${f.outlet}`;
  const m = await master(
    "planogram",
    {
      lines: [
        { productId: f.sku, facings: 3, position: "A" },
        { productId: second.id.toUpperCase(), facings: 2, position: "B" },
      ],
      targetSharePercent: 50,
    },
    f.now - DAY,
    klass,
  );
  const snapshot = await outletRetail(ctx(f), { id: f.outlet });
  const [product] = await h.db`select name from products where id=${f.sku}`;
  expect(
    snapshot.planogram.data.lines.map(
      (/** @type {any} */ line) => line.productName,
    ),
  ).toEqual([product.name, "Second shelf product"]);
  await expect(
    (async () => {
      await h.db`delete from products where id=${second.id}`;
    })(),
  ).rejects.toThrow("planogram");
  expect(
    (await h.db`select id from products where id=${second.id}`).length,
  ).toBe(1);
  await h.db`update retail_master_versions set effective_to=${new Date(Date.now() + DAY)} where id=${m.id}`;
});
test("F-314 outlet snapshots do not depend on a national equipment prefix", async () => {
  const f = await started(),
    foreign = await fixture(),
    asset = await freezer(f),
    prefix = crypto.randomUUID();
  await h.db`insert into retail_master_versions(kind,code,version,label,outlet_class,effective_from,data,source,actor_subject)
 select 'equipment',${prefix}||g::text,1,'Other-store sample asset','*',now()-interval '1 day',jsonb_build_object('outletId',${foreign.outlet}::text,'policyVersionId',${asset.policy.id}::text,'serial',${prefix}||g::text,'sapFixedAssetId','SAP-'||${prefix}||g::text,'model','Test','custodian','Test','agreement','Sample','location','Cebu','type','freezer','deployedAt',${f.now - DAY}::bigint),'sample','fixture' from generate_series(1,501) g`;
  expect(
    (await outletRetail(ctx(f), { id: f.outlet })).equipment.map(
      (/** @type {any} */ m) => m.id,
    ),
  ).toEqual([asset.equipment.id]);
});
