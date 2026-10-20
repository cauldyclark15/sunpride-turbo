import { beforeAll, afterAll, test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { install } from "../src/domains/fiscal/index.js";
import {
  saveRegistration,
  createSeries,
  allocateDocumentNumber,
  issueDocument,
} from "../src/domains/fiscal/series.js";
import { retireAllocation } from "../src/domains/fiscal/reconciliation.js";
/** @type {any} */ let h;
/** @type {any} */ let seller;
/** @type {any} */ let actor;
/** @type {any} */ let approver;
/** @type {any} */ let allocation;
/** @type {string} */ let cookie;
const unit = crypto.randomUUID();
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  const people = profileStore(h);
  h.setHooks({ unitInScope: async () => true });
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','NATIONAL','SAMPLE fiscal branch','national','active',now()-interval '1 day')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('finish-fiscal','org_units',${unit},'branch')`;
  seller = await boundDevice(h, people, {
    app: "van-android",
    orgUnitId: unit,
  });
  const bossId = await createUser(
    h,
    "audit@example.test",
    "test-only-fiscal-password",
  );
  const boss = {
    userId: bossId,
    email: "audit@example.test",
    profile: people.set(bossId, {
      role: "super_admin",
      orgUnitId: unit,
      name: "Independent administrator",
    }),
  };
  for (const person of [seller, boss]) {
    const p = person.profile;
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${person.userId},${person.userId},${p.name},${person.email},${p.role},'active',${unit})`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','fixture','fixture')`;
  }
  actor = await actorFor(h.db, seller.userId);
  approver = await actorFor(h.db, bossId);
  const r = await tx(h.db, (db) =>
    saveRegistration(db, approver, {
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
  const s = await tx(h.db, (db) =>
    createSeries(db, approver, {
      registrationId: r.id,
      prefix: "SAMPLE-0570",
      firstSerial: "1",
      lastSerial: "5",
      effectiveFrom: "2026-01-01T00:00:00Z",
    }),
  );
  allocation = await tx(h.db, (db) =>
    allocateDocumentNumber(db, {
      actor,
      deviceId: seller.deviceId,
      seriesId: s.id,
      requestKey: crypto.randomUUID(),
      count: 2,
    }),
  );
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: boss.email,
      password: "test-only-fiscal-password",
    }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
});
afterAll(async () => await h?.close());
test("F-019 retired lost range is immutable, never recycled and cannot issue after reinstatement", async () => {
  const input = {
    allocationId: allocation.allocationId,
    outcome: "lost_unreconciled",
    reason: "SAMPLE lost handset",
    evidenceReference: "SAMPLE incident",
  };
  await expect(
    tx(h.db, (db) => retireAllocation(db, approver, input)),
  ).rejects.toThrow("Suspend or retire");
  await h.db`update registered_devices set status='suspended' where id=${seller.deviceId}`;
  const closed = await tx(h.db, (db) => retireAllocation(db, approver, input));
  expect(closed.duplicate).toBe(false);
  expect(
    (await tx(h.db, (db) => retireAllocation(db, approver, input))).duplicate,
  ).toBe(true);
  await expect(
    Promise.resolve(
      h.db`delete from fiscal_allocation_closures where id=${closed.id}`,
    ),
  ).rejects.toThrow("append-only");
  const [s] =
    await h.db`select next_allocate from fiscal_series where id=${allocation.seriesId}`;
  expect(String(s.next_allocate)).toBe("3");
  await h.db`update registered_devices set status='active' where id=${seller.deviceId}`;
  await expect(
    tx(h.db, (db) =>
      issueDocument(db, {
        actor,
        deviceId: seller.deviceId,
        allocationId: allocation.allocationId,
        documentType: "sales_invoice",
        sourceType: "test",
        sourceId: crypto.randomUUID(),
        serial: "1",
        at: Date.now(),
        snapshot: {},
      }),
    ),
  ).rejects.toThrow("permanently retired");
  expect(
    await h.db`select * from fiscal_documents where allocation_id=${allocation.allocationId}`,
  ).toHaveLength(0);
});
test("F-020 integrated identity changes are audited and filtered export remains national-only", async () => {
  await tx(h.db, async (db) => {
    await db`select set_config('sunpride.actor',${approver.userId},true)`;
    await db`insert into identity_providers(code,label,issuer,client_id,redirect_uri,effective_from,source_ref) values('sample_finish','SAMPLE company','https://id.example.test','sample','https://app.example.test/api/auth/oidc/callback',now(),'SAMPLE')`;
  });
  const res = await h.fetch(
    "/api/v1/fiscal/audit?table=identity_providers&action=INSERT",
    { headers: { cookie } },
  );
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.items).toHaveLength(1);
  expect(data.items[0].actor_name).toBe("Independent administrator");
  expect(data.items[0].after_facts.code).toBe("sample_finish");
  expect(
    (
      await h.fetch(
        "/api/v1/fiscal/audit?table=identity_providers&action=DELETE",
        { headers: { cookie } },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await h.fetch("/api/v1/fiscal/audit", {
        headers: { authorization: `Bearer ${seller.access}` },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await h.fetch("/api/v1/fiscal/audit?table=bad%20table", {
        headers: { cookie },
      })
    ).status,
  ).toBe(422);
});
