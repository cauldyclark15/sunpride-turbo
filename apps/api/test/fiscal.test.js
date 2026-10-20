import { beforeAll, afterAll, expect, test } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  signedPost,
  createUser,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { tx } from "@sunpride/db/client";
import { install } from "../src/domains/fiscal/index.js";
import {
  allocateDocumentNumber,
  issueDocument,
  documentEvent,
  saveRegistration,
  createSeries,
} from "../src/domains/fiscal/series.js";
import {
  requestOverride,
  enforceAuthority,
  decideOverride,
  saveRule,
} from "../src/domains/fiscal/authority.js";
import {
  taxSnapshot,
  invoiceForSale,
} from "../src/domains/fiscal/transactions.js";
import { install as installVan } from "../src/domains/van/index.js";
import { PAYMENT_METHODS, today } from "../src/domains/van/model.js";
import {
  validateTender,
  tenderPolicy,
  configuredTender,
  saveTenderRule,
  confirmTender,
} from "../src/domains/fiscal/tenders.js";
/** @type {any} */ let h;
/** @type {any} */ let people;
/** @type {any} */ let seller;
/** @type {any} */ let boss;
/** @type {any} */ let actor;
/** @type {any} */ let approver;
const unit = crypto.randomUUID();
/** @type {any} */ let reg;
/** @type {any} */ let series;
/** @type {any} */ let allocation;
/** @type {any} */ let document;
/** @param {any} user */
async function persist(user) {
  const p = user.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${unit})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','fixture','fixture')`;
}
beforeAll(async () => {
  h = await startHarness({ installers: [install, installVan] });
  people = profileStore(h);
  h.setHooks({ unitInScope: async () => true });
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','NATIONAL','Sample fiscal branch','national','active',now()-interval '1 day')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('fiscal-test','org_units',${unit},'branch')`;
  seller = await boundDevice(h, people, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persist(seller);
  const userId = await createUser(
    h,
    "fiscalboss@example.com",
    "a-test-password-only",
  );
  boss = {
    userId,
    email: "fiscalboss@example.com",
    profile: people.set(userId, {
      role: "super_admin",
      orgUnitId: unit,
      name: "Second person",
    }),
  };
  await persist(boss);
  actor = await actorFor(h.db, seller.userId);
  approver = await actorFor(h.db, boss.userId);
  reg = await tx(h.db, (db) =>
    saveRegistration(db, approver, {
      orgUnitId: unit,
      entityName: "SAMPLE company",
      branchName: "Sample Cebu",
      tin: "SAMPLE 000-000",
      address: "Sample address",
      documentType: "sales_invoice",
      status: "sample_not_filed",
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  );
  series = await tx(h.db, (db) =>
    createSeries(db, approver, {
      registrationId: reg.id,
      prefix: "SAMPLE-SI",
      firstSerial: "1",
      lastSerial: "1000",
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  );
});
afterAll(async () => h?.close());
test("F-018 sample register is explicitly not filed; only separate real evidence can be verified", async () => {
  const [r] = await h.db`select * from fiscal_registrations where id=${reg.id}`;
  expect(r.status).toBe("sample_not_filed");
  expect(r.sample).toBe(true);
  const userId = await createUser(
    h,
    "independent-fiscal-verifier@example.com",
    "a-test-password-only",
  );
  const person = {
    userId,
    email: "independent-fiscal-verifier@example.com",
    profile: people.set(userId, {
      role: "super_admin",
      orgUnitId: unit,
      name: "Independent verifier",
    }),
  };
  await persist(person);
  const verifier = await actorFor(h.db, userId);
  if (!verifier) throw new Error("Verifier fixture is missing");
  const input = {
    orgUnitId: unit,
    entityName: r.entity_name,
    branchName: r.branch_name,
    tin: r.tin,
    address: r.address,
    documentType: r.document_type,
    taxBasisPoints: 1200,
    effectiveFrom: "2026-01-01T00:00:00Z",
    permitReference: "TEST permit (not a filing)",
    evidenceReference: "TEST evidence",
  };
  await expect(
    tx(h.db, (db) =>
      saveRegistration(db, verifier, {
        ...input,
        id: reg.id,
        status: "approved",
      }),
    ),
  ).rejects.toThrow("Sample registration cannot become a live permit");
  const separate = await tx(h.db, (db) =>
    saveRegistration(db, approver, { ...input, status: "draft" }),
  );
  await expect(
    tx(h.db, (db) =>
      saveRegistration(db, approver, {
        ...input,
        id: separate.id,
        status: "approved",
      }),
    ),
  ).rejects.toThrow("second administrator");
  await tx(h.db, (db) =>
    saveRegistration(db, verifier, {
      ...input,
      id: separate.id,
      status: "approved",
    }),
  );
  const [verified] =
    await h.db`select * from fiscal_registrations where id=${separate.id}`;
  expect(verified.verified_by).toBe(verifier.profileId);
  expect(verified.entered_by).toBe(approver.profileId);
  const expiry = new Date(Date.now() + 86400000).toISOString();
  await tx(h.db, (db) =>
    saveRegistration(db, verifier, {
      ...input,
      id: separate.id,
      status: "approved",
      effectiveTo: expiry,
    }),
  );
  for (const effectiveTo of [undefined, ""]) {
    await tx(h.db, (db) =>
      saveRegistration(db, verifier, {
        ...input,
        id: separate.id,
        status: "approved",
        effectiveTo,
      }),
    );
    const [retained] =
      await h.db`select effective_to from fiscal_registrations where id=${separate.id}`;
    expect(retained.effective_to).not.toBeNull();
    expect(new Date(retained.effective_to).toISOString()).toBe(expiry);
  }
});
test("F-019 concurrent offline reservations are disjoint and replay never resets a consumed range", async () => {
  const reserve = (/** @type {string} */ key) =>
    tx(h.db, (db) =>
      allocateDocumentNumber(db, {
        actor,
        deviceId: seller.deviceId,
        seriesId: series.id,
        requestKey: key,
        count: 10,
      }),
    );
  const key = crypto.randomUUID();
  const [a, b] = await Promise.all([
    reserve(key),
    reserve(crypto.randomUUID()),
  ]);
  allocation = a;
  expect(
    BigInt(a.firstSerial) > BigInt(b.lastSerial) ||
      BigInt(b.firstSerial) > BigInt(a.lastSerial),
  ).toBe(true);
  expect((await reserve(key)).allocationId).toBe(a.allocationId);
  await expect(
    tx(h.db, (db) =>
      allocateDocumentNumber(db, {
        actor,
        deviceId: seller.deviceId,
        seriesId: series.id,
        requestKey: key,
        count: 11,
      }),
    ),
  ).rejects.toThrow();
});
const source = crypto.randomUUID();
/** @param {string} serial */
const issue = (serial) => ({
  actor,
  deviceId: seller.deviceId,
  allocationId: allocation.allocationId,
  serial,
  sourceType: "test_sale",
  sourceId: source,
  documentType: "sales_invoice",
  at: Date.now(),
  snapshot: { totalMinor: "11200", tax: taxSnapshot("11200", 1200) },
});
test("F-019 offline first serial is contiguous, changed replay and a skipped serial are refused without consuming", async () => {
  const input = issue(allocation.firstSerial);
  document = await tx(h.db, (db) => issueDocument(db, input));
  expect(document.document_number).toBe(
    "SAMPLE-SI-" + allocation.firstSerial.padStart(9, "0"),
  );
  expect((await tx(h.db, (db) => issueDocument(db, input))).id).toBe(
    document.id,
  );
  await expect(
    tx(h.db, (db) =>
      issueDocument(db, { ...input, snapshot: { totalMinor: "1" } }),
    ),
  ).rejects.toThrow();
  await expect(
    tx(h.db, (db) =>
      issueDocument(db, {
        ...issue(String(BigInt(allocation.firstSerial) + 2n)),
        sourceId: crypto.randomUUID(),
      }),
    ),
  ).rejects.toThrow();
  expect(
    String(
      (
        await h.db`select next_issue from fiscal_allocations where id=${allocation.allocationId}`
      )[0].next_issue,
    ),
  ).toBe(String(BigInt(allocation.firstSerial) + 1n));
});
test("F-109 immutable snapshot and explicit REPRINT journal survive master edits", async () => {
  await tx(h.db, (db) =>
    documentEvent(db, actor, {
      documentId: document.id,
      requestKey: crypto.randomUUID(),
      kind: "reprint",
      reason: "Customer copy",
      outcome: "not_printed",
    }),
  );
  const [event] =
    await h.db`select * from fiscal_document_events where document_id=${document.id} and kind='reprint'`;
  expect(event.facts.copy).toBe("REPRINT");
  expect(document.snapshot.registration.entityName).toBe("SAMPLE company");
  await h.db`update fiscal_registrations set entity_name='Changed after offline reservation',tax_basis_points=0 where id=${reg.id}`;
  const later = await tx(h.db, (db) =>
    issueDocument(db, {
      ...issue(String(BigInt(allocation.firstSerial) + 1n)),
      sourceId: crypto.randomUUID(),
    }),
  );
  expect(later.snapshot.registration.entityName).toBe("SAMPLE company");
  expect(later.snapshot.registration.taxBasisPoints).toBe(1200);
  await expect(
    tx(
      h.db,
      async (db) =>
        await db`update fiscal_documents set snapshot='{}' where id=${document.id}`,
    ),
  ).rejects.toThrow("append-only");
  await expect(
    tx(
      h.db,
      async (db) =>
        await db`delete from fiscal_documents where id=${document.id}`,
    ),
  ).rejects.toThrow("append-only");
});
test("F-019 range counters cannot move backwards or be recycled after device replacement", async () => {
  await expect(
    tx(
      h.db,
      async (db) =>
        await db`update fiscal_allocations set next_issue=first_serial where id=${allocation.allocationId}`,
    ),
  ).rejects.toThrow();
  await expect(
    tx(
      h.db,
      async (db) =>
        await db`delete from fiscal_allocations where id=${allocation.allocationId}`,
    ),
  ).rejects.toThrow();
  await expect(
    tx(
      h.db,
      async (db) =>
        await db`update fiscal_series set prefix='REUSED' where id=${series.id}`,
    ),
  ).rejects.toThrow();
});
/** @type {any} */ let override;
const facts = {
  saleId: crypto.randomUUID(),
  originalMinor: "11200",
  proposedMinor: "9200",
};
test("F-124 F-511 over-threshold discount refuses, cannot self-approve, then a second person approves exact facts", async () => {
  await tx(h.db, (db) =>
    saveRule(db, approver, {
      orgUnitId: unit,
      kind: "discount",
      role: "sales",
      channel: "GT",
      minCentavos: "0",
      maxCentavos: "100000",
      selfLimitCentavos: "500",
      approverRoles: ["super_admin", "manager"],
      offlineAllowed: true,
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  );
  override = await tx(h.db, (db) =>
    requestOverride(db, actor, {
      id: crypto.randomUUID(),
      orgUnitId: unit,
      kind: "discount",
      channel: "GT",
      amountCentavos: "2000",
      reason: "Sample damaged label allowance",
      facts,
    }),
  );
  expect(override.requiresSecond).toBe(true);
  const consume = {
    orgUnitId: unit,
    kind: "discount",
    channel: "GT",
    amountCentavos: "2000",
    overrideId: override.id,
    operationId: crypto.randomUUID(),
    facts,
  };
  await expect(
    tx(h.db, (db) => enforceAuthority(db, actor, consume)),
  ).rejects.toThrow("second approver");
  await expect(
    tx(h.db, (db) =>
      decideOverride(db, actor, {
        id: override.id,
        decision: "approved",
        reason: "Self",
      }),
    ),
  ).rejects.toThrow();
  const approved = await tx(h.db, (db) =>
    decideOverride(db, approver, {
      id: override.id,
      decision: "approved",
      reason: "Verified exact discount",
      offline: true,
    }),
  );
  expect(approved.offlineCode?.startsWith("OV-")).toBe(true);
  await expect(
    tx(h.db, (db) =>
      enforceAuthority(db, actor, {
        ...consume,
        facts: { ...facts, proposedMinor: "1" },
      }),
    ),
  ).rejects.toThrow();
  await expect(
    tx(h.db, (db) =>
      enforceAuthority(db, actor, { ...consume, offlineCode: "OV-wrong" }),
    ),
  ).rejects.toThrow();
  expect(
    (
      await tx(h.db, (db) =>
        enforceAuthority(db, actor, {
          ...consume,
          offlineCode: approved.offlineCode,
        }),
      )
    ).overrideId,
  ).toBe(override.id);
  await expect(
    tx(h.db, (db) =>
      enforceAuthority(db, actor, {
        ...consume,
        operationId: crypto.randomUUID(),
      }),
    ),
  ).rejects.toThrow("already consumed");
});
test("F-511 missing channel policy and overlapping value bands fail closed", async () => {
  await expect(
    tx(h.db, (db) =>
      requestOverride(db, actor, {
        id: crypto.randomUUID(),
        orgUnitId: unit,
        kind: "discount",
        channel: "MT",
        amountCentavos: "2000",
        reason: "Test",
        facts,
      }),
    ),
  ).rejects.toThrow("missing");
  await expect(
    tx(h.db, (db) =>
      saveRule(db, approver, {
        orgUnitId: unit,
        kind: "discount",
        role: "sales",
        channel: "GT",
        minCentavos: "0",
        maxCentavos: "3000",
        selfLimitCentavos: "500",
        approverRoles: ["manager"],
        effectiveFrom: "2026-01-01T00:00:00Z",
      }),
    ),
  ).rejects.toThrow("overlap");
});
test("F-511 withdrawing the approver after approval refuses consumption without a business write", async () => {
  const capture = { ...facts, saleId: crypto.randomUUID() };
  const req = await tx(h.db, (db) =>
    requestOverride(db, actor, {
      id: crypto.randomUUID(),
      orgUnitId: unit,
      kind: "discount",
      channel: "GT",
      amountCentavos: "2000",
      reason: "Exact concession",
      facts: capture,
    }),
  );
  await tx(h.db, (db) =>
    decideOverride(db, approver, {
      id: req.id,
      decision: "approved",
      reason: "Approved exact facts",
    }),
  );
  const consume = {
    orgUnitId: unit,
    kind: "discount",
    channel: "GT",
    amountCentavos: "2000",
    overrideId: req.id,
    operationId: crypto.randomUUID(),
    facts: capture,
  };
  await h.db`update profiles set status='disabled' where id=${approver.profileId}`;
  try {
    await expect(
      tx(h.db, (db) => enforceAuthority(db, actor, consume)),
    ).rejects.toThrow("access changed");
    expect(
      (
        await h.db`select count(*)::int as n from fiscal_override_events where request_id=${req.id} and kind='consumed'`
      )[0].n,
    ).toBe(0);
  } finally {
    await h.db`update profiles set status='active' where id=${approver.profileId}`;
  }
  await tx(h.db, (db) => enforceAuthority(db, actor, consume));
});
test("F-020 ordinary SQL cannot rewrite audit or decisions; each master edit and override is captured", async () => {
  const [audit] =
    await h.db`select * from fiscal_audit_events where table_name='fiscal_override_events' limit 1`;
  expect(audit).toBeDefined();
  await expect(
    tx(
      h.db,
      async (db) =>
        await db`delete from fiscal_audit_events where id=${audit.id}`,
    ),
  ).rejects.toThrow("append-only");
  await expect(
    tx(
      h.db,
      async (db) =>
        await db`update fiscal_override_events set reason='tampered' where request_id=${override.id}`,
    ),
  ).rejects.toThrow("append-only");
  const [r] =
    await h.db`insert into audit_logs(subject,action,entity_type,entity_id) values('test','test','test','test') returning id`;
  await expect(
    tx(
      h.db,
      async (db) =>
        await db`update audit_logs set details='changed' where id=${r.id}`,
    ),
  ).rejects.toThrow("append-only");
  await expect(
    tx(h.db, async (db) => await db`delete from audit_logs where id=${r.id}`),
  ).rejects.toThrow("append-only");
});
test("F-111 tender policy is editable, prospective and validates historical offline captures", async () => {
  const from =
    Date.parse(
      new Date(Date.now() + 86400000).toISOString().slice(0, 10) +
        "T00:00:00+08:00",
    ) + 86400000;
  const input = {
    orgUnitId: unit,
    method: "maya",
    label: "Branch Maya",
    referenceLabel: "Maya approval",
    enabled: true,
    effectiveFrom: new Date(from).toISOString(),
  };
  await tx(h.db, (db) => saveTenderRule(db, approver, input));
  expect(await tenderPolicy(h.db, unit, from - 1)).toEqual([]);
  expect(
    (
      await configuredTender(
        h.db,
        unit,
        { method: "maya", reference: "AUTH-123" },
        from + 1,
      )
    ).label,
  ).toBe("Branch Maya");
  await tx(h.db, (db) =>
    saveTenderRule(db, approver, {
      ...input,
      enabled: false,
      effectiveFrom: new Date(from + 86400000).toISOString(),
    }),
  );
  expect((await tenderPolicy(h.db, unit, from + 1)).length).toBe(1);
  await expect(
    configuredTender(
      h.db,
      unit,
      { method: "maya", reference: "AUTH-123" },
      from + 86400001,
    ),
  ).rejects.toThrow("not authorized");
  await expect(
    tx(h.db, (db) =>
      saveTenderRule(db, approver, {
        ...input,
        effectiveFrom: new Date().toISOString(),
      }),
    ),
  ).rejects.toThrow("future Manila midnight");
  await h.db`insert into fiscal_tender_rules(org_unit_id,method,label,effective_from,entered_by) values(${unit},'maya','Conflicting',${new Date(from - 1)},${approver.profileId})`;
  await expect(tenderPolicy(h.db, unit, from + 1)).rejects.toThrow("overlaps");
});
test("F-111 seeded tender prompts satisfy the frozen native wire bounds", async () => {
  const schema = await Bun.file(
    new URL(
      "../../../packages/domain-contracts/schemas/van-v1.schema.json",
      import.meta.url,
    ),
  ).json();
  const fields = schema.$defs.paymentMethod.properties;
  for (const method of PAYMENT_METHODS) {
    expect(method.label.length).toBeLessThanOrEqual(fields.label.maxLength);
    if (method.referenceLabel)
      expect(method.referenceLabel.length).toBeLessThanOrEqual(
        fields.referenceLabel.maxLength,
      );
  }
});
test("F-111 provider references are required, PANs and unconfirmed paid claims refuse", () => {
  for (const method of ["maya", "card", "gcash", "check"]) {
    expect(
      validateTender({
        method,
        reference: "AUTH-123",
        status: "awaiting_confirmation",
      }).code,
    ).toBe(method);
    expect(() => validateTender({ method, reference: "" })).toThrow();
    expect(() =>
      validateTender({ method, reference: "AUTH-123", status: "paid" }),
    ).toThrow();
  }
  for (const reference of [
    "4111 1111 1111 1111",
    "4111.1111.1111.1111",
    "4111/1111/1111/1111",
    "4111_1111_1111_1111",
    "AUTH4111111111111111",
  ])
    expect(() => validateTender({ method: "card", reference })).toThrow();
});
test("F-108 F-111 signed collection issues an OR, rejects duplicates and replaces a declined tender without recycling", async () => {
  const location = crypto.randomUUID(),
    vehicle = crypto.randomUUID(),
    tripId = crypto.randomUUID(),
    outlet = crypto.randomUUID(),
    saleId = crypto.randomUUID();
  // Existing migrated credit-invoice fixture. The original invoice's creation is not this test's proof.
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${location},'sunpride',${unit},'TEST','OR-TRUCK','Sample OR truck','truck',true,true,true,true,false)`;
  await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${vehicle},'sunpride',${unit},'OR-TRUCK','TEST',${location},${location},'active','fixture')`;
  await h.db`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,started_device_id,created_by) values(${tripId},'sunpride',${unit},'OR-TEST',${vehicle},${location},${location},${today()},${actor.profileId},${actor.subject},'active',${seller.deviceId},'fixture')`;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values(${outlet},'sunpride','OR-CUSTOMER','Sample customer','active',${unit},'GT','fixture')`;
  await h.db`insert into van_sales(id,trip_id,receipt_number,outlet_id,total_centavos,receipt,captured_request) values(${saleId},${tripId},'SAMPLE-OLD-CREDIT',${outlet},10000,${{ payment: { kind: "credit", method: "credit" } }},${{}})`;
  for (const method of ["cash", "gcash", "credit"])
    await h.db`insert into fiscal_tender_rules(org_unit_id,method,label,effective_from,sample,entered_by) values(${unit},${method},${method},'2026-01-01',true,${approver.profileId})`;
  const registration = await tx(h.db, (db) =>
    saveRegistration(db, approver, {
      orgUnitId: unit,
      entityName: "SAMPLE company",
      branchName: "Sample branch",
      tin: "SAMPLE",
      address: "Sample address",
      documentType: "official_receipt",
      status: "sample_not_filed",
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  );
  const series = await tx(h.db, (db) =>
    createSeries(db, approver, {
      registrationId: registration.id,
      prefix: "SAMPLE-OR",
      firstSerial: "1",
      lastSerial: "100",
      vehicleId: vehicle,
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  );
  const range = await tx(h.db, (db) =>
    allocateDocumentNumber(db, {
      actor,
      deviceId: seller.deviceId,
      seriesId: series.id,
      count: 10,
      requestKey: crypto.randomUUID(),
    }),
  );
  const operation = (
    /** @type {string} */ method,
    /** @type {string} */ serial,
  ) => {
    const at = Date.now();
    return {
      clientOpId: crypto.randomUUID(),
      opType: "payment.record",
      clientTime: at,
      dependsOn: [],
      payload: {
        tripId,
        saleId,
        method,
        amountMinor: "6000",
        status: method === "cash" ? "paid" : "awaiting_confirmation",
        reference: method === "cash" ? undefined : "GCASH-TEST-123",
        fiscal: { allocationId: range.allocationId, serial },
        deviceTime: at,
      },
    };
  };
  const push = (/** @type {any} */ op) =>
    signedPost(h, seller, "/api/sync/push", {
      version: 2,
      app: "van-android",
      deviceId: seller.deviceId,
      scopeId: unit,
      operations: [op],
    });
  const victim = await boundDevice(h, people, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persist(victim);
  const foreign = await actorFor(h.db, victim.userId);
  const foreignSeries = await tx(h.db, (db) =>
    createSeries(db, approver, {
      registrationId: registration.id,
      prefix: "SAMPLE-OTHER-OR",
      firstSerial: "1",
      lastSerial: "100",
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  );
  const foreignRange = await tx(h.db, (db) =>
    allocateDocumentNumber(db, {
      actor: foreign,
      deviceId: victim.deviceId,
      seriesId: foreignSeries.id,
      count: 10,
      requestKey: crypto.randomUUID(),
    }),
  );
  const forged = operation("cash", "1");
  Object.assign(forged.payload.fiscal, {
    allocationId: foreignRange.allocationId,
    actor: foreign,
    deviceId: victim.deviceId,
    vehicleId: null,
  });
  expect((await push(forged)).body.results[0].status).not.toBe("applied");
  expect(
    (
      await h.db`select next_issue from fiscal_allocations where id=${foreignRange.allocationId}`
    )[0].next_issue.toString(),
  ).toBe("1");
  expect(
    (
      await h.db`select count(*)::int as n from van_payments where sale_id=${saleId}`
    )[0].n,
  ).toBe(0);
  const credit = operation("credit", "1");
  credit.payload.status = "credit";
  expect((await push(credit)).body.results[0].status).not.toBe("applied");
  expect(
    (
      await h.db`select next_issue from fiscal_allocations where id=${range.allocationId}`
    )[0].next_issue.toString(),
  ).toBe("1");
  const first = operation("gcash", "1");
  Object.assign(first.payload, { untrusted: "UNTRUSTED-COLLECTION-MARKER" });
  const applied = await push(first);
  expect(applied.body.results[0].status, JSON.stringify(applied.body)).toBe(
    "applied",
  );
  expect((await push(first)).body.results[0].status).toBe("duplicate");
  const [payment] =
    await h.db`select id from van_payments where sale_id=${saleId} and kind='collection'`;
  await expect(
    tx(h.db, (db) =>
      confirmTender(db, actor, {
        paymentId: payment.id,
        decision: "confirmed",
        reason: "Self",
      }),
    ),
  ).rejects.toThrow();
  await tx(h.db, (db) =>
    confirmTender(db, approver, {
      paymentId: payment.id,
      decision: "rejected",
      reason: "Provider refused transfer",
    }),
  );
  const replaced = await push(operation("cash", "2"));
  expect(replaced.body.results[0].status, JSON.stringify(replaced.body)).toBe(
    "applied",
  );
  const tooMuch = await push(operation("cash", "3"));
  expect(tooMuch.body.results[0].status).not.toBe("applied");
  const [voidApproval] =
    await h.db`insert into van_approval_codes(trip_id,kind,facts_hash,facts,issuer_profile_id,issuer_name) values(${tripId},'void','fixture',${{}},${approver.profileId},'Fixture verifier') returning id`;
  await h.db`insert into van_sale_voids(sale_id,trip_id,reason,approval_id) values(${saleId},${tripId},'wrong_items',${voidApproval.id})`;
  const afterVoid = operation("cash", "3");
  afterVoid.payload.amountMinor = "1";
  expect((await push(afterVoid)).body.results[0].status).not.toBe("applied");
  const docs =
    await h.db`select * from fiscal_documents where allocation_id=${range.allocationId} order by serial`;
  expect(docs.map((/** @type {any} */ d) => String(d.serial))).toEqual([
    "1",
    "2",
  ]);
  expect(docs[0].snapshot.documentType).toBe("official_receipt");
  expect(docs[0].snapshot.invoiceNumber).toBe("SAMPLE-OLD-CREDIT");
  expect(docs[0].snapshot.totalMinor).toBe("6000");
  expect(docs[0].snapshot.payment.untrusted).toBeUndefined();
  expect(docs[0].snapshot.payment.fiscal).toBeUndefined();
  expect(docs[0].snapshot.payment.amountMinor).toBe("6000");
  // F-108: legacy invoices are never invented from current masters. Collections
  // persist but their shared SAP queue remains fenced behind the absent invoice.
  expect((await h.db`select count(*)::int n from integration_events where source_type='van_sale' and source_id=${saleId}`)[0].n).toBe(0);
  const pending = await h.db`select status,depends_on from integration_events where source_type='van_payment' and payload->'document'->'facts'->>'tripId'=${tripId}`;
  expect(pending.length).toBeGreaterThan(0);
  for (const row of pending) {
    expect(row.status).toBe("pending");
    expect(row.depends_on).toContain(`invoice:van_sale:${saleId}`);
  }
  expect(
    (
      await h.db`select count(*)::int as n from fiscal_posting_requests where document_id in ${h.db(docs.map((/** @type {any} */ d) => d.id))}`
    )[0].n,
  ).toBe(2);
  expect(
    (
      await h.db`select next_issue from fiscal_allocations where id=${range.allocationId}`
    )[0].next_issue.toString(),
  ).toBe("3");
});
test("F-019 F-108 fiscal identity cannot spend another handheld's reserved invoice range", async () => {
  const victim = await boundDevice(h, people, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persist(victim);
  const foreign = await actorFor(h.db, victim.userId);
  const range = await tx(h.db, (db) =>
    allocateDocumentNumber(db, {
      actor: foreign,
      deviceId: victim.deviceId,
      seriesId: series.id,
      count: 10,
      requestKey: crypto.randomUUID(),
    }),
  );
  const saleId = crypto.randomUUID();
  await expect(
    tx(h.db, (db) =>
      invoiceForSale(
        db,
        actor,
        { org_unit_id: unit, vehicle_id: null },
        {
          saleId,
          deviceTime: Date.now(),
          fiscal: {
            allocationId: range.allocationId,
            serial: range.nextSerial,
            actor: foreign,
            deviceId: victim.deviceId,
            vehicleId: null,
          },
        },
        { totalMinor: "11200" },
        seller.deviceId,
      ),
    ),
  ).rejects.toThrow("not allocated to this handheld");
  expect(
    (
      await h.db`select next_issue from fiscal_allocations where id=${range.allocationId}`
    )[0].next_issue.toString(),
  ).toBe(range.nextSerial);
  expect(
    (
      await h.db`select count(*)::int as n from fiscal_documents where source_id=${saleId}`
    )[0].n,
  ).toBe(0);
});
test("F-020 audit pagination retains every row sharing one transaction timestamp", async () => {
  await h.db`insert into fiscal_audit_events(table_name,row_id,action,actor_subject,after_facts) select 'paging-fixture',${unit},'UPDATE','fiscal-fixture',jsonb_build_object('sample',true,'ordinal',n) from generate_series(1,105) n`;
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: boss.email,
      password: "a-test-password-only",
    }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const expected = (
    await h.db`select count(*)::int as n from fiscal_audit_events`
  )[0].n;
  const ids = new Set();
  /** @type {string|null} */ let cursor = null;
  for (let page = 0; page < 20; page++) {
    /** @type {Response} */
    const r = await h.fetch(
      "/api/v1/fiscal/audit" +
        (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      { headers: { cookie } },
    );
    expect(r.status).toBe(200);
    /** @type {{items:Array<{id:string}>,hasMore:boolean,nextCursor:string|null}} */
    const body = await r.json();
    for (const row of body.items) {
      expect(ids.has(row.id)).toBe(false);
      ids.add(row.id);
    }
    if (!body.hasMore) {
      expect(body.nextCursor).toBeNull();
      break;
    }
    expect(typeof body.nextCursor).toBe("string");
    cursor = body.nextCursor;
  }
  expect(ids.size).toBe(expected);
});
test("F-111 tender totals cover the full authorized source, not the 500-row display cap", async () => {
  const location = crypto.randomUUID(),
    vehicle = crypto.randomUUID(),
    tripId = crypto.randomUUID(),
    outlet = crypto.randomUUID();
  const initial = (
    await h.db`select coalesce(sum(case when p.kind in ('refund','void_refund') then -p.amount_centavos else p.amount_centavos end),0)::text as n from van_payments p join van_trips t on t.id=p.trip_id where t.org_unit_id=${unit} and t.service_date=${today()} and p.method='cash'`
  )[0].n;
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${location},'sunpride',${unit},'TEST','SUMMARY-TRUCK','Sample summary truck','truck',true,true,true,true,false)`;
  await h.db`insert into vehicles(id,organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by) values(${vehicle},'sunpride',${unit},'SUMMARY-TRUCK','TEST',${location},${location},'active','fixture')`;
  await h.db`insert into van_trips(id,organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by) values(${tripId},'sunpride',${unit},'SUMMARY-TEST',${vehicle},${location},${location},${today()},${actor.profileId},${actor.subject},'closed','fixture')`;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values(${outlet},'sunpride','SUMMARY-CUSTOMER','Sample summary customer','active',${unit},'GT','fixture')`;
  // Retained operational sales fixture; no claim that these are newly issued tax invoices.
  await h.db`with saved as (insert into van_sales(id,trip_id,receipt_number,outlet_id,total_centavos,receipt,captured_request) select gen_random_uuid(),${tripId},'LEGACY-SUMMARY-'||n,${outlet},100,${{ payment: { kind: "cash", method: "cash" } }},${{}} from generate_series(1,501)n returning id) insert into van_payments(id,trip_id,sale_id,kind,method,amount_centavos,facts) select gen_random_uuid(),${tripId},id,'sale','cash',100,${{}} from saved`;
  const [sale] =
    await h.db`select id from van_sales where trip_id=${tripId} limit 1`;
  await h.db`insert into van_payments(id,trip_id,sale_id,kind,method,amount_centavos,facts) values(${crypto.randomUUID()},${tripId},${sale.id},'refund','cash',50,${{}})`;
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: boss.email,
      password: "a-test-password-only",
    }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const res = await h.fetch(
    "/api/v1/fiscal/register?branchId=" + unit + "&day=" + today(),
    { headers: { cookie } },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.truncated).toBe(true);
  expect(body.tenders.length).toBe(500);
  expect(body.tenderTotals).toBeDefined();
  const cash = body.tenderTotals.find(
    (/** @type {any} */ r) => r.method === "cash",
  );
  expect(cash.captured_centavos).toBe(
    String(BigInt(initial) + 501n * 100n - 50n),
  );
  expect(cash.awaiting_count).toBe(0);
});
test("F-108 tax snapshot reconciles exact inclusive VAT without floating point", () => {
  expect(taxSnapshot("11200", 1200)).toEqual({
    inclusive: true,
    rateBasisPoints: 1200,
    vatableSalesMinor: "10000",
    vatMinor: "1200",
    vatExemptMinor: "0",
    zeroRatedMinor: "0",
    totalMinor: "11200",
  });
  expect(taxSnapshot("100", 0).vatExemptMinor).toBe("100");
});
