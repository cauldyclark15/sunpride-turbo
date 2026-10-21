import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { install } from "../src/domains/fiscal/index.js";
import {
  saveRegistration,
  createSeries,
  allocateDocumentNumber,
  issueDocument,
} from "../src/domains/fiscal/series.js";

test("F-109 collection Official Receipt print journal resolves the payment, not the original sale", async () => {
  const h = await startHarness({ installers: [install] });
  try {
    const people = profileStore(h),
      unit = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SAMPLE','SAMPLE branch','national','active',now()-interval '1 day')`;
    await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('finish-collection','org_units',${unit},'branch')`;
    const seller = await boundDevice(h, people, {
      app: "van-android",
      orgUnitId: unit,
    });
    const bossId = await createUser(
      h,
      "collection-admin@example.test",
      "test-only-collection-password",
    );
    const boss = {
      userId: bossId,
      email: "collection-admin@example.test",
      profile: people.set(bossId, {
        role: "super_admin",
        orgUnitId: unit,
        name: "SAMPLE admin",
      }),
    };
    for (const user of [seller, boss]) {
      const p = user.profile;
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${unit})`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','fixture','SAMPLE')`;
    }
    const actor = await actorFor(h.db, seller.userId),
      admin = await actorFor(h.db, bossId);
    const reg = await tx(h.db, (db) =>
      saveRegistration(db, admin, {
        orgUnitId: unit,
        entityName: "SAMPLE",
        branchName: "SAMPLE",
        tin: "SAMPLE",
        address: "SAMPLE",
        documentType: "official_receipt",
        status: "sample_not_filed",
        effectiveFrom: "2026-01-01T00:00:00Z",
      }),
    );
    const series = await tx(h.db, (db) =>
      createSeries(db, admin, {
        registrationId: reg.id,
        prefix: "SAMPLE-0571-OR",
        firstSerial: "1",
        lastSerial: "2",
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
    const paymentId = crypto.randomUUID();
    const doc = await tx(h.db, (db) =>
      issueDocument(db, {
        actor,
        deviceId: seller.deviceId,
        allocationId: range.allocationId,
        documentType: "official_receipt",
        sourceType: "van_collection",
        sourceId: paymentId,
        serial: "1",
        at: Date.now(),
        snapshot: { totalMinor: "2500" },
      }),
    );
    const op = {
      clientOpId: crypto.randomUUID(),
      opType: "fiscal.print",
      clientTime: Date.now(),
      dependsOn: [],
      payload: {
        paymentId,
        kind: "print",
        outcome: "not_printed",
        reason: "SAMPLE printer unavailable",
        printId: crypto.randomUUID(),
      },
    };
    const response = await signedPost(h, seller, "/api/sync/push", {
      version: 2,
      app: "van-android",
      deviceId: seller.deviceId,
      scopeId: unit,
      operations: [op],
    });
    expect(response.res.status).toBe(200);
    const data = response.body;
    expect(data.results[0]).toMatchObject({ status: "applied" });
    const events =
      await h.db`select document_id,facts from fiscal_document_events where request_key=${op.clientOpId}`;
    expect(events).toHaveLength(1);
    expect(events[0].document_id).toBe(doc.id);
    expect(events[0].facts.outcome).toBe("not_printed");
  } finally {
    await h.close();
  }
});
