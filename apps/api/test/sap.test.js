import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startHarness } from "./harness.js";
import { startMock } from "../../sap-mock/src/server.js";
import { sampleMasters, sampleMaster } from "../../sap-mock/src/sample.js";
import { install } from "../src/domains/integration/index.js";
import {
  enqueueSapPosting,
  runOutbox,
  heartbeat,
  claimPostings,
} from "../src/domains/integration/outbox.js";
import {
  ingestMaster,
  resolveSapPrice,
  syncMasters,
} from "../src/domains/integration/replicas.js";
import {
  sapCreditCheck,
  bindCreditDecision,
} from "../src/domains/integration/credit.js";

/** @type {import('./harness.js').Harness} */ let h;
/** @type {ReturnType<typeof startMock>} */ let mock;
/** @type {Record<string,string>} */ let env;
const document = {
  sourceType: "test",
  sourceId: "test",
  customerCode: "MOCK-C1",
  currency: "PHP",
  amountCentavos: 4500,
  occurredAt: Date.now(),
  lines: [],
  facts: { sample: true },
};
/** @param {string} kind @param {any} [doc] */
async function queue(kind, doc = document) {
  const sourceId = crypto.randomUUID();
  return tx(h.db, (t) =>
    enqueueSapPosting(t, {
      kind,
      sourceType: "test",
      sourceId,
      document: { ...doc, sourceId },
    }),
  );
}
/** @param {any} b */
async function fault(b) {
  const r = await fetch(mock.origin + "/control/fault", {
    method: "POST",
    body: JSON.stringify(b),
  });
  expect(r.status).toBe(200);
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  mock = startMock({ path: h.filesDir + "/sap.sqlite", port: 0 });
  env = { SAP_ORIGIN: mock.origin, SAP_TIMEOUT_MS: "1000" };
});
afterAll(async () => {
  mock?.stop();
  await h?.close();
});

describe("F-001 SAP versioned round trips", () => {
  test("F-001 every posting interface validates and gets one stable SAP number", async () => {
    for (const kind of [
      "order",
      "invoice",
      "payment",
      "goods_movement",
      "credit_memo",
      "settlement",
    ]) {
      const q = await queue(kind);
      await runOutbox(h.db, { env });
      const [r] = await h.db`select * from integration_events where id=${q.id}`;
      expect(r.status).toBe("completed");
      expect(r.external_document_number).toContain("SAMPLE-");
      expect(r.sap_result.payloadHash).toBe(r.payload_hash);
    }
  });
  test("F-001 all master endpoints page into replicas with SAP provenance", async () => {
    const n = await syncMasters(h.db, env);
    expect(n).toBe(sampleMasters.length);
    const rows = await h.db`select * from sap_replicas`;
    expect(rows.length).toBe(sampleMasters.length);
    const [product] = await h.db`select * from products where code='MOCK-M1'`;
    expect(product.storage_condition).toContain("sample");
    expect(product.catalog_source).toBe("sap_sample");
    const price = await resolveSapPrice(h.db, {
      organizationId: "sunpride",
      productId: product.id,
      uom: "PC",
      channelKey: "gt",
      customerCode: "MOCK-C1",
      at: Date.now(),
    });
    expect(price.unitPriceCentavos).toBe(4500);
    expect(price.taxBasisPoints).toBe(1200);
    expect(await syncMasters(h.db, env)).toBe(0);
  });
});

describe("F-003 exactly-once effects across failures", () => {
  test("F-003 concurrent claims and replay never duplicate SAP documents", async () => {
    const q = await queue("invoice");
    await Promise.all([runOutbox(h.db, { env }), runOutbox(h.db, { env })]);
    const [r] = await h.db`select * from integration_events where id=${q.id}`;
    const replay = await tx(h.db, (t) =>
      enqueueSapPosting(t, {
        kind: r.event_type,
        sourceType: r.source_type,
        sourceId: r.source_id,
        document: r.payload.document,
      }),
    );
    expect(replay.duplicate).toBe(true);
    expect(
      mock.db
        .query("select count(*) as n from receipts where effect=?")
        .get(r.event_id).n,
    ).toBe(1);
  });
  test("F-003 changed payload under the same key is quarantined, never overwritten", async () => {
    const q = await queue("order");
    const [r] = await h.db`select * from integration_events where id=${q.id}`;
    const changed = await tx(h.db, (t) =>
      enqueueSapPosting(t, {
        kind: "order",
        sourceType: r.source_type,
        sourceId: r.source_id,
        document: { ...r.payload.document, amountCentavos: 999 },
      }),
    );
    expect(changed.quarantined).toBe(true);
    const [original] =
      await h.db`select payload_hash from integration_events where id=${q.id}`;
    expect(original.payload_hash).toBe(r.payload_hash);
    expect(
      (
        await h.db`select * from integration_conflicts where event_id=${r.event_id}`
      ).length,
    ).toBe(1);
  });
  test("F-003 accepted but response lost recovers by external effect lookup", async () => {
    const q = await queue("payment");
    await fault({ target: "payment", mode: "accept_drop", count: 1 });
    await runOutbox(h.db, { env });
    const [r] = await h.db`select * from integration_events where id=${q.id}`;
    expect(r.status).toBe("failed");
    await h.db`update integration_events set next_attempt_at=now() where id=${q.id}`;
    await runOutbox(h.db, { env });
    const [done] =
      await h.db`select * from integration_events where id=${q.id}`;
    expect(done.status).toBe("completed");
    expect(done.attempts).toBe(2);
    expect(
      mock.db
        .query("select count(*) as n from receipts where effect=?")
        .get(r.event_id).n,
    ).toBe(1);
  });
  test("F-003 dead letter retains bytes and retry recovers the same effect", async () => {
    const q = await queue("credit_memo");
    await fault({ target: "credit_memo", mode: "reject", count: 1 });
    await runOutbox(h.db, { env });
    const [r] = await h.db`select * from integration_events where id=${q.id}`;
    expect(r.status).toBe("dead_letter");
    expect(r.error_class).toBe("rejection");
    await h.db`update integration_events set status='pending',next_attempt_at=now() where id=${q.id}`;
    await runOutbox(h.db, { env });
    const [done] =
      await h.db`select * from integration_events where id=${q.id}`;
    expect(done.status).toBe("completed");
    expect(done.payload_hash).toBe(r.payload_hash);
  });
  test("F-003 expired claim is stolen and old heartbeat is fenced", async () => {
    const q = await queue("settlement");
    const rows = await claimPostings(h.db);
    const r = rows.find((x) => x.id === q.id);
    expect(r).toBeDefined();
    await h.db`update integration_events set lease_expires_at=now()-interval '1 second' where id=${q.id}`;
    expect(await heartbeat(h.db, q.id, r.lease_token)).toBe(false);
    await runOutbox(h.db, { env });
    const [done] =
      await h.db`select status from integration_events where id=${q.id}`;
    expect(done.status).toBe("completed");
  });
  test("F-119 caller rollback also rolls back outbox creation", async () => {
    const id = crypto.randomUUID();
    await expect(
      tx(h.db, async (t) => {
        await enqueueSapPosting(t, {
          kind: "invoice",
          sourceType: "test",
          sourceId: id,
          document: { ...document, sourceId: id },
        });
        throw new Error("business rollback");
      }),
    ).rejects.toThrow("business rollback");
    expect(
      (await h.db`select * from integration_events where source_id=${id}`)
        .length,
    ).toBe(0);
  });
});

test("F-003 retry taxonomy reaches dead letter after five transport failures, preserving exact bytes", async () => {
  const q = await queue("goods_movement");
  await fault({ target: "goods_movement", mode: "fail", count: 5 });
  const [original] =
    await h.db`select payload_hash from integration_events where id=${q.id}`;
  for (let i = 1; i <= 5; i++) {
    await h.db`update integration_events set next_attempt_at=now() where id=${q.id}`;
    await runOutbox(h.db, { env });
    const [r] = await h.db`select * from integration_events where id=${q.id}`;
    expect(r.attempts).toBe(i);
    expect(r.status).toBe(i === 5 ? "dead_letter" : "failed");
    expect(r.error_class).toBe("transport");
    expect(r.payload_hash).toBe(original.payload_hash);
  }
});

test("F-003 SAP acceptance followed by a local acknowledgement failure is recovered without reposting", async () => {
  const q = await queue("invoice");
  await h.db`create table sap_ack_failures(id uuid primary key)`;
  await h.db`insert into sap_ack_failures values(${q.id})`;
  await h.db.unsafe(
    `create function sap_test_ack_guard() returns trigger language plpgsql as $$ begin if new.status='completed' and exists(select 1 from sap_ack_failures f where f.id=new.id) then raise exception 'injected local acknowledgement failure'; end if; return new; end $$;create trigger sap_test_ack_failure before update on integration_events for each row execute function sap_test_ack_guard()`,
  );
  try {
    await runOutbox(h.db, { env });
    const [failed] =
      await h.db`select * from integration_events where id=${q.id}`;
    expect(failed.status).toBe("failed");
    expect(sapReceiptCount(failed.event_id)).toBe(1);
    await h.db`delete from sap_ack_failures where id=${q.id}`;
    await h.db`update integration_events set next_attempt_at=now() where id=${q.id}`;
    await runOutbox(h.db, { env });
    const [done] =
      await h.db`select * from integration_events where id=${q.id}`;
    expect(done.status).toBe("completed");
    expect(sapReceiptCount(done.event_id)).toBe(1);
  } finally {
    await h.db.unsafe(
      "drop trigger sap_test_ack_failure on integration_events;drop function sap_test_ack_guard();drop table sap_ack_failures",
    );
  }
});
/** @param {string} effect */
function sapReceiptCount(effect) {
  return mock.db
    .query("select count(*) as n from receipts where effect=?")
    .get(effect).n;
}

test("F-015/F-016 SAP master versions are deterministic and customer conditions beat channel/base", async () => {
  const [p] = await h.db`select id from products where code='MOCK-M1'`;
  const base = sampleMasters.find((x) => x.kind === "condition");
  if (!base) throw new Error("Missing SAP fixture");
  const channel = sampleMaster("condition", "CHANNEL", {
    ...base.data,
    channelKey: "gt",
    unitPriceCentavos: 4300,
  });
  const customer = sampleMaster("condition", "CUSTOMER", {
    ...base.data,
    customerCode: "MOCK-C1",
    unitPriceCentavos: 4100,
  });
  await ingestMaster(h.db, channel);
  await ingestMaster(h.db, customer);
  const args = {
    organizationId: "sunpride",
    productId: p.id,
    uom: "PC",
    channelKey: "gt",
    customerCode: "MOCK-C1",
    at: Date.now(),
  };
  expect((await resolveSapPrice(h.db, args)).unitPriceCentavos).toBe(4100);
  const changed = {
    ...customer,
    version: 2,
    data: { ...customer.data, unitPriceCentavos: 4050 },
  };
  await ingestMaster(h.db, changed);
  await ingestMaster(h.db, customer);
  expect((await resolveSapPrice(h.db, args)).unitPriceCentavos).toBe(4050);
  const conflict = await ingestMaster(h.db, {
    ...changed,
    data: { ...changed.data, unitPriceCentavos: 1 },
  });
  expect(conflict.quarantined).toBe(true);
  expect((await resolveSapPrice(h.db, args)).unitPriceCentavos).toBe(4050);
});

test("F-112/F-404 fresh decisions bind exact amounts; over/stale cannot confirm", async () => {
  const d = await sapCreditCheck(h.db, "MOCK-C1", 1000, { env });
  expect(d.status).toBe("within");
  expect(d.freshness).toBe("live");
  const source = crypto.randomUUID();
  const id = await tx(h.db, (t) =>
    bindCreditDecision(t, {
      customerCode: "MOCK-C1",
      amountCentavos: 1000,
      sourceType: "test",
      sourceId: source,
      env,
    }),
  );
  expect(
    await tx(h.db, (t) =>
      bindCreditDecision(t, {
        customerCode: "MOCK-C1",
        amountCentavos: 1000,
        sourceType: "test",
        sourceId: source,
        env,
      }),
    ),
  ).toBe(id);
  await expect(
    tx(h.db, (t) =>
      bindCreditDecision(t, {
        customerCode: "MOCK-C1",
        amountCentavos: 1001,
        sourceType: "test",
        sourceId: source,
        env,
      }),
    ),
  ).rejects.toThrow("Credit facts changed");
  await expect(
    tx(h.db, (t) =>
      bindCreditDecision(t, {
        customerCode: "MOCK-C1",
        amountCentavos: 9000000,
        sourceType: "test",
        sourceId: crypto.randomUUID(),
        env,
      }),
    ),
  ).rejects.toThrow("SAP refused");
  await fault({ target: "check", mode: "fail", count: 1 });
  const stale = await sapCreditCheck(h.db, "MOCK-C1", 100, { env });
  expect(stale.status).toBe("unknown");
  expect(stale.freshness).toBe("stale");
  expect(stale.policy).toBe("capture_pending_only");
});

test("F-003 database dates and omitted properties are hashed as their actual immutable JSON wire bytes", async () => {
  const when = new Date("2026-10-20T00:00:00.000Z");
  const q = await queue("invoice", {
    ...document,
    facts: { when, omitted: undefined, nested: [{ when }] },
  });
  const [stored] =
    await h.db`select * from integration_events where id=${q.id}`;
  expect(stored.payload.document.facts.when).toBe(when.toISOString());
  expect(stored.payload.document.facts).not.toHaveProperty("omitted");
  await runOutbox(h.db, { env });
  const [done] = await h.db`select * from integration_events where id=${q.id}`;
  expect(done.status).toBe("completed");
  expect(done.sap_result.payloadHash).toBe(stored.payload_hash);
  expect(sapReceiptCount(stored.event_id)).toBe(1);
});

test("F-119 payments wait for their invoice and changed dependencies under an existing key are quarantined", async () => {
  const parent = await queue("invoice");
  const [invoice] =
    await h.db`select event_id from integration_events where id=${parent.id}`;
  const sourceId = crypto.randomUUID();
  const input = {
    kind: "payment",
    sourceType: "test",
    sourceId,
    dependsOn: [invoice.event_id],
    document: { ...document, sourceId },
  };
  const child = await tx(h.db, (t) => enqueueSapPosting(t, input));
  await runOutbox(h.db, { env });
  const [waiting] =
    await h.db`select status from integration_events where id=${child.id}`;
  expect(waiting.status).toBe("pending");
  await runOutbox(h.db, { env });
  const [done] =
    await h.db`select * from integration_events where id=${child.id}`;
  expect(done.status).toBe("completed");
  expect(sapReceiptCount(done.event_id)).toBe(1);
  const changed = await tx(h.db, (t) =>
    enqueueSapPosting(t, { ...input, dependsOn: [] }),
  );
  expect(changed.quarantined).toBe(true);
  const [original] =
    await h.db`select depends_on from integration_events where id=${child.id}`;
  expect(original.depends_on).toEqual([invoice.event_id]);
});

test("F-112 unknown SAP credit stays retryable, not a permanent native rejection, and the same confirmation resumes", async () => {
  const sourceId = crypto.randomUUID();
  const input = {
    customerCode: "MOCK-C1",
    amountCentavos: 100,
    sourceType: "pending-proof",
    sourceId,
    env,
  };
  await fault({ target: "check", mode: "fail", count: 1 });
  const error = await tx(h.db, (t) => bindCreditDecision(t, input)).then(
    () => null,
    (e) => e,
  );
  expect(error.status).toBe(503);
  expect(error.retryable).toBe(true);
  expect(error.action).toBe("retry");
  expect(
    (
      await h.db`select * from sap_credit_decisions where consumed_by=${"pending-proof:" + sourceId}`
    ).length,
  ).toBe(0);
  const id = await tx(h.db, (t) => bindCreditDecision(t, input));
  const replay = await tx(h.db, (t) => bindCreditDecision(t, input));
  expect(replay).toBe(id);
});

test("F-016 an exclusive-tax condition stays replicated but cannot masquerade as a complete selling or credit amount", async () => {
  const fixture = sampleMasters.find((m) => m.kind === "condition");
  if (!fixture) throw new Error("Missing SAP condition fixture");
  const condition = sampleMaster("condition", "EXCLUSIVE-TAX", {
    ...fixture.data,
    customerCode: "EXCLUSIVE-ACCOUNT",
    taxInclusive: false,
    taxBasisPoints: 1200,
  });
  await ingestMaster(h.db, condition);
  const [product] =
    await h.db`select id from products where code=${condition.data.productCode}`;
  const price = await resolveSapPrice(h.db, {
    organizationId: "sunpride",
    productId: product.id,
    uom: condition.data.uom,
    channelKey: null,
    customerCode: "EXCLUSIVE-ACCOUNT",
    at: Date.now(),
  });
  expect(price.unitPriceCentavos).toBeNull();
  expect(price.source).toBe("sap_tax_quote_required");
  expect(
    (
      await sapCreditCheck(h.db, "EXCLUSIVE-ACCOUNT", price.unitPriceCentavos, {
        env,
      })
    ).status,
  ).toBe("unknown");
  expect(
    (await h.db`select * from sap_replicas where sap_key='EXCLUSIVE-TAX'`)
      .length,
  ).toBe(1);
});
