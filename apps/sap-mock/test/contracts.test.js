import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { startMock } from "../src/server.js";
import { sampleMasters, sampleMaster } from "../src/sample.js";
import {
  schemas,
  validate,
  payloadHash,
} from "../../../packages/integration-contracts/sap/v1/index.js";
let sap, dir;
beforeAll(async () => {
  dir = await mkdtemp(
    `${process.env.TMPDIR ?? process.env.HOME + "/.hermes/cache/scratch"}/sap-contract-`,
  );
  sap = startMock({ path: dir + "/state.sqlite", port: 0 });
});
afterAll(async () => {
  sap.stop();
  await rm(dir, { recursive: true, force: true });
});
const envelope = (kind) => ({
  schemaVersion: 1,
  organizationId: "sunpride",
  kind,
  effectId: "contract-" + kind,
  correlationId: "roundtrip-" + kind,
  document: {
    sourceType: "contract",
    sourceId: "contract-" + kind,
    customerCode: "MOCK-C1",
    currency: "PHP",
    amountCentavos: 100,
    occurredAt: Date.now(),
    lines: [
      {
        productCode: "MOCK-M1",
        uom: "PC",
        quantityBase: 1,
        lotId: "SAMPLE-BATCH",
        fromLocationCode: null,
        toLocationCode: "MOCK-DEPOT",
        unitPriceCentavos: 100,
        taxCode: "SAMPLE-VAT12",
        taxBasisPoints: 1200,
      },
    ],
    facts: { sample: true },
  },
});
const post = (path, body) =>
  fetch(sap.origin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("F-001 all v1 schema keywords are explicitly implemented by the runtime validator", () => {
  const supported = new Set([
    "$schema",
    "$id",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "const",
    "enum",
    "anyOf",
    "items",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "maxItems",
  ]);
  function inspect(s) {
    for (const k of Object.keys(s)) expect(supported.has(k), k).toBe(true);
    if (s.properties) Object.values(s.properties).forEach(inspect);
    if (s.items) inspect(s.items);
    if (s.anyOf) s.anyOf.forEach(inspect);
  }
  for (const schema of Object.values(schemas)) inspect(schema);
});
test("F-001 all master fixtures validate and malformed UOM, omitted-null and foreign fields fail", () => {
  for (const m of sampleMasters) expect(validate(m.kind, m)).toBe(m);
  const material = sampleMasters.find((x) => x.kind === "material");
  expect(() => validate("material", { ...material, unexpected: true })).toThrow(
    "invalid_contract",
  );
  expect(() =>
    validate("material", {
      ...material,
      data: { ...material.data, quantityScale: 1.5 },
    }),
  ).toThrow("invalid_contract");
  expect(() =>
    validate("material", {
      ...material,
      data: { ...material.data, quantityScale: Number.MAX_SAFE_INTEGER + 1 },
    }),
  ).toThrow("invalid_contract");
  const omitted = { ...material };
  delete omitted.effectiveTo;
  expect(() => validate("material", omitted)).toThrow("invalid_contract");
});
test("F-001/F-003 every financial interface replays the identical SAP response", async () => {
  for (const kind of [
    "order",
    "invoice",
    "payment",
    "goods_movement",
    "credit_memo",
    "settlement",
  ]) {
    const b = envelope(kind),
      a = await post("/v1/postings/" + kind, b);
    expect(a.status).toBe(200);
    const first = await a.json();
    validate("postingResult", first);
    const replay = await post(
      "/v1/postings/" + kind,
      JSON.parse(JSON.stringify(b)),
    );
    expect(await replay.json()).toEqual(first);
    expect(first.payloadHash).toBe(payloadHash(b));
    expect(
      (
        await post("/v1/postings/" + kind, {
          ...b,
          document: { ...b.document, amountCentavos: 101 },
        })
      ).status,
    ).toBe(409);
  }
});
test("F-001 mock fails/rejects before posting, and accepted response loss retains its receipt", async () => {
  const b = envelope("invoice");
  b.effectId = "FAULT-INVOICE";
  await post("/control/fault", { target: "invoice", mode: "fail", count: 1 });
  expect((await post("/v1/postings/invoice", b)).status).toBe(503);
  await post("/control/fault", { target: "invoice", mode: "reject", count: 1 });
  expect((await post("/v1/postings/invoice", b)).status).toBe(422);
  expect((await fetch(sap.origin + "/v1/postings/" + b.effectId)).status).toBe(
    404,
  );
  await post("/control/fault", {
    target: "invoice",
    mode: "accept_drop",
    count: 1,
  });
  expect((await post("/v1/postings/invoice", b)).status).toBe(503);
  const found = await fetch(sap.origin + "/v1/postings/" + b.effectId);
  expect(found.status).toBe(200);
  expect((await found.json()).effectId).toBe(b.effectId);
});

test("F-101 goods posting refuses an unmapped depot and exact replay succeeds after the SAP master is published", async () => {
  const b = envelope("goods_movement");
  b.effectId = "mapping-proof";
  b.document.amountCentavos = null;
  b.document.lines[0].toLocationCode = "SAMPLE-NEW-DEPOT";
  expect((await post("/v1/postings/goods_movement", b)).status).toBe(422);
  expect((await fetch(sap.origin + "/v1/postings/" + b.effectId)).status).toBe(
    404,
  );
  const master = sampleMaster("location", "SAMPLE-NEW-DEPOT", {
    locationCode: "SAMPLE-NEW-DEPOT",
    plant: "SAMPLE-PLANT",
    storageLocation: "SAMPLE-NEW",
    status: "active",
  });
  expect((await post("/control/masters", { items: [master] })).status).toBe(
    200,
  );
  const accepted = await post("/v1/postings/goods_movement", b);
  expect(accepted.status).toBe(200);
  expect((await accepted.json()).payloadHash).toBe(payloadHash(b));
  expect((await post("/v1/postings/goods_movement", b)).status).toBe(200);
  expect(
    sap.db
      .query("select count(*) as n from receipts where effect=?")
      .get(b.effectId).n,
  ).toBe(1);
});
test("F-112 reservations are shared across channels, exact retries do not reserve twice, previews never reserve", async () => {
  await post("/control/credit", {
    customerCode: "CREDIT",
    limitCentavos: 1000,
    exposureCentavos: 100,
  });
  const request = {
    schemaVersion: 1,
    customerCode: "CREDIT",
    amountCentavos: 600,
    currency: "PHP",
    requestId: "preview",
    reserve: false,
  };
  const preview = await (await post("/v1/credit/check", request)).json();
  expect(preview.status).toBe("within");
  expect(
    sap.db
      .query("select exposure from credit_accounts where customer=?")
      .get("CREDIT").exposure,
  ).toBe(100);
  const first = await (
    await post("/v1/credit/check", {
      ...request,
      requestId: "van:one",
      reserve: true,
    })
  ).json();
  expect(first.status).toBe("within");
  expect(
    await (
      await post("/v1/credit/check", {
        ...request,
        requestId: "van:one",
        reserve: true,
      })
    ).json(),
  ).toEqual(first);
  const field = await (
    await post("/v1/credit/check", {
      ...request,
      amountCentavos: 400,
      requestId: "field:two",
      reserve: true,
    })
  ).json();
  expect(field.status).toBe("over");
  expect(field.exposureCentavos).toBe(700);
  expect(
    (
      await post("/v1/credit/check", {
        ...request,
        amountCentavos: 601,
        requestId: "van:one",
        reserve: true,
      })
    ).status,
  ).toBe(409);
});
test("F-003 SQLite state survives mock service restart without changing receipt identity", async () => {
  const b = envelope("settlement");
  b.effectId = "RESTART-SETTLEMENT";
  const result = await (await post("/v1/postings/settlement", b)).json();
  const path = dir + "/state.sqlite";
  sap.stop();
  sap = startMock({ path, port: 0 });
  expect(
    await (await fetch(sap.origin + "/v1/postings/" + b.effectId)).json(),
  ).toEqual(result);
  expect(await (await post("/v1/postings/settlement", b)).json()).toEqual(
    result,
  );
  expect(
    sap.db
      .query("select count(*) as n from receipts where effect=?")
      .get(b.effectId).n,
  ).toBe(1);
});
