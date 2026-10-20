import { afterAll, beforeAll, expect, test } from "bun:test";
import { createUser, profileStore, startHarness } from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
import { tx } from "@sunpride/db/client";
import { install } from "../src/domains/integration/index.js";
import {
  enqueueSapPosting,
  runOutbox,
} from "../src/domains/integration/outbox.js";
import {
  ingestMaster,
  activateMasters,
  masterId,
} from "../src/domains/integration/replicas.js";
import { sampleMasters, sampleMaster } from "../../sap-mock/src/sample.js";
import { startMock } from "../../sap-mock/src/server.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let admin;
/** @type {any} */ let viewer;
/** @type {any} */ let regional;
/** @type {ReturnType<typeof startMock>} */ let sap;
let eventId = "";
/** @param {any} who @param {string} path @param {any} [body] */
async function api(who, path, body) {
  const res = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  sap = startMock({ path: h.filesDir + "/sap-console.sqlite", port: 0 });
  h.env.SAP_ORIGIN = sap.origin;
  const profiles = profileStore(h),
    unit = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','REG','Region','region','active','2020-01-01')`;
  const people = [];
  for (const role of ["super_admin", "viewer", "admin"]) {
    const user = await createUser(
        h,
        role + "@console.invalid",
        "test password long enough",
      ),
      p = profiles.set(user, { role, orgUnitId: unit, name: role });
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user},${user},${role},${role + "@console.invalid"},${role},'active',${unit})`;
    const token = "sps_" + crypto.randomUUID().replaceAll("-", "");
    await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${user},${sha256Hex(token)},'web',now()+interval '1 day')`;
    people.push({ id: p.id, cookie: `sp_session=${token}` });
  }
  [admin, viewer, regional] = people;
  h.setHooks({ rootUnitId: async () => crypto.randomUUID() });
  const q = await tx(h.db, (t) =>
    enqueueSapPosting(t, {
      kind: "invoice",
      sourceType: "test",
      sourceId: "console",
      document: {
        sourceType: "test",
        sourceId: "console",
        customerCode: "MOCK-C1",
        currency: "PHP",
        amountCentavos: 4500,
        occurredAt: Date.now(),
        lines: [],
        facts: {},
      },
    }),
  );
  eventId = q.id;
  await fetch(sap.origin + "/control/fault", {
    method: "POST",
    body: JSON.stringify({ target: "invoice", mode: "reject", count: 1 }),
  });
  await runOutbox(h.db, { env: h.env });
});
afterAll(async () => {
  sap?.stop();
  await h?.close();
});

test("F-005 console denies viewer and non-national administrator on reads and actions", async () => {
  for (const who of [viewer, regional]) {
    expect((await api(who, "/api/v1/integration/events")).status).toBe(403);
    expect(
      (
        await api(who, "/api/v1/integration/retry", {
          id: eventId,
          reason: "Source corrected",
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(who, "/api/v1/integration/trace?id=" + eventId)).status,
    ).toBe(403);
  }
});
test("F-005 rejected post appears with age, owner and immutable resolution trace", async () => {
  const list = await api(admin, "/api/v1/integration/events");
  expect(list.status).toBe(200);
  expect(list.body.counts.failed).toBe(1);
  expect(list.body.rows[0].status).toBe("dead_letter");
  expect(list.body.rows[0].owner).toBeNull();
  expect(
    (
      await api(admin, "/api/v1/integration/assign", {
        id: eventId,
        reason: "Integration operator owns correction",
        ownerProfileId: admin.id,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api(admin, "/api/v1/integration/escalate", {
        id: eventId,
        reason: "Business mapping needs review",
      })
    ).status,
  ).toBe(200);
  const trace = await api(admin, "/api/v1/integration/trace?id=" + eventId);
  expect(trace.body.event.escalated).toBe(true);
  expect(trace.body.history.map((/** @type {any} */ x) => x.action)).toContain(
    "assign",
  );
  await expect(
    tx(h.db, async (db) => {
      await db`update integration_resolution_events set action='erased' where event_id=${eventId}`;
    }),
  ).rejects.toThrow("append only");
});
test("F-005 retry original dead letter is audited and results in one SAP document", async () => {
  const retry = await api(admin, "/api/v1/integration/retry", {
    id: eventId,
    reason: "Corrected source; replay original",
  });
  expect(retry.status).toBe(200);
  await runOutbox(h.db, { env: h.env });
  const trace = await api(admin, "/api/v1/integration/trace?id=" + eventId);
  expect(trace.body.event.status).toBe("completed");
  expect(trace.body.event.documentNumber).toContain("SAMPLE-INVOICE");
  expect(trace.body.history.map((/** @type {any} */ x) => x.action)).toContain(
    "retry",
  );
  expect(sap.db.query("select count(*) as n from receipts").get().n).toBe(1);
  expect(
    (
      await api(admin, "/api/v1/integration/retry", {
        id: eventId,
        reason: "Replay completed record",
      })
    ).body.duplicate,
  ).toBe(true);
  expect(sap.db.query("select count(*) as n from receipts").get().n).toBe(1);
});
test("F-015 used UOM conflict becomes a rejected inbox record and preserves product", async () => {
  const fixture = sampleMasters.find((x) => x.kind === "material");
  await ingestMaster(h.db, fixture);
  const [p] = await h.db`select * from products where code='MOCK-M1'`;
  // An incompatible pack is rejected even before any historical posted stock is rewritten.
  const incoming = {
    ...fixture,
    version: 2,
    data: {
      ...fixture.data,
      packs: fixture.data.packs.map((/** @type {any} */ x) =>
        x.uom === "CASE" ? { ...x, numerator: 12 } : x,
      ),
    },
  };
  const r = await ingestMaster(h.db, incoming);
  const [event] = await h.db`select * from integration_events where id=${r.id}`;
  expect(event.status).toBe("dead_letter");
  expect(event.error_class).toBe("conflict");
  const [kept] = await h.db`select sap_version from products where id=${p.id}`;
  expect(Number(kept.sap_version)).toBe(1);
  expect(
    (
      await api(admin, "/api/v1/integration/retry", {
        id: r.id,
        reason: "Verify unchanged rejected master",
      })
    ).status,
  ).toBe(200);
  expect(
    (await h.db`select status from integration_events where id=${r.id}`)[0]
      .status,
  ).toBe("dead_letter");
});
test("F-004 future activation and expiry publish stable master tombstones", async () => {
  const fixture = sampleMaster("customer", "FUTURE", {
    code: "FUTURE",
    name: "Sample future account",
    channel: "gt",
    territory: "Sample",
    status: "active",
  });
  fixture.effectiveFrom = Date.now() + 60000;
  await ingestMaster(h.db, fixture);
  expect((await h.db`select * from customers where code='FUTURE'`).length).toBe(
    0,
  );
  // Advance just this fixture's retained effective instant; do not change test thresholds/timeouts.
  await h.db`update sap_replicas set effective_from=now()-interval '1 second' where sap_key='FUTURE'`;
  await activateMasters(h.db);
  expect(
    (await h.db`select active from customers where code='FUTURE'`)[0].active,
  ).toBe(true);
  const id = masterId("customer", "FUTURE");
  await h.db`update sap_replicas set effective_to=now()-interval '1 millisecond' where sap_key='FUTURE'`;
  await activateMasters(h.db);
  expect(
    (
      await h.db`select op from change_log where entity_id=${id} order by seq desc limit 1`
    )[0].op,
  ).toBe("tombstone");
  expect(
    (await h.db`select active from customers where code='FUTURE'`)[0].active,
  ).toBe(false);
});

test("F-015 a browser cannot upload a forged SAP replica, even as national administrator", async () => {
  const result = await api(
    admin,
    "/api/v1/integration/masters/ingest",
    sampleMasters[0],
  );
  expect(result.status).toBe(404);
});

test("F-003/F-404 credit breach requests replay exactly, reject changed facts and never authorize local credit", async () => {
  const body = {
    customerCode: "MOCK-C1",
    amountCentavos: 10000000,
    reason: "Independent SAP credit exception requested",
    idempotencyKey: crypto.randomUUID(),
  };
  const first = await api(admin, "/api/v1/credit/request-override", body);
  expect(first.status).toBe(200);
  expect(first.body.status).toBe("pending_sap");
  const replay = await api(admin, "/api/v1/credit/request-override", body);
  expect(replay.body.id).toBe(first.body.id);
  expect(replay.body.duplicate).toBe(true);
  expect(
    (
      await api(admin, "/api/v1/credit/request-override", {
        ...body,
        amountCentavos: 1,
      })
    ).status,
  ).toBe(409);
  expect(
    (await api(viewer, "/api/v1/credit/request-override", body)).status,
  ).toBe(403);
  const [saved] =
    await h.db`select * from sap_credit_override_requests where id=${first.body.id}`;
  expect(saved.status).toBe("pending_sap");
  expect(Number(saved.amount_centavos)).toBe(body.amountCentavos);
  expect(
    (
      await h.db`select * from sap_credit_decisions where consumed_by is not null`
    ).length,
  ).toBe(0);
});
