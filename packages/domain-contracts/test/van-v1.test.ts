import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schemas/van-v1.schema.json";

/**
 * VAN-003 wire contract for the separate van-sales POS (ADR-010). Every fixture under
 * fixtures/van-v1 must validate, and the Android app reads the same files in place
 * (apps/van-sales-android/app/build.gradle.kts test resources).
 */
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const fixtureDir = new URL("../fixtures/van-v1/", import.meta.url);
const read = async (name: string): Promise<Record<string, unknown>> =>
  Bun.file(new URL(name, fixtureDir)).json();
/** Wire envelopes; `void-approval.json` holds VAN-021 code vectors, not an envelope. */
const VOID_VECTORS = "void-approval.json";
/** VAN-022 cash approval code vectors, not an envelope. */
const CASH_VECTORS = "cash-approval.json";
const names = (
  await Array.fromAsync(
    new Bun.Glob("*.json").scan({ cwd: fixtureDir.pathname }),
  )
)
  .filter((name) => name !== VOID_VECTORS && name !== CASH_VECTORS)
  .sort();

describe("van v1 contract fixtures", () => {
  test("covers every envelope type", async () => {
    const types = new Set<string>();
    for (const name of names) types.add(String((await read(name)).type));
    expect([...types].sort()).toEqual([
      "error.response",
      "van.bootstrap.request",
      "van.bootstrap.response",
      "van.evidence.request",
      "van.evidence.response",
      "van.push.request",
      "van.push.response",
    ]);
  });

  for (const name of names)
    test(`${name} validates`, async () => {
      const ok = validate(await read(name));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });

  test("rejects unknown fields, float base quantities and unknown kinds", async () => {
    const push = await read("push-request.json");
    const operations = push.operations as Record<string, unknown>[];
    const first = operations[0]!;
    const firstPayload = first.payload as Record<string, unknown>;
    expect(
      validate({
        ...push,
        operations: [{ ...first, payload: { ...firstPayload, extra: 1 } }],
      }),
    ).toBe(false);
    expect(
      validate({
        ...push,
        operations: [
          {
            ...first,
            payload: {
              ...firstPayload,
              lines: [{ lineNumber: 1, actualBase: "4.5" }],
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      validate({ ...push, operations: [{ ...first, kind: "sale.post" }] }),
    ).toBe(false);
  });

  test("a trip start must confirm vehicle and route", async () => {
    const push = await read("push-request.json");
    const start = (push.operations as Record<string, unknown>[])[1]!;
    expect(
      validate({
        ...push,
        operations: [
          {
            ...start,
            payload: {
              ...(start.payload as Record<string, unknown>),
              routeConfirmed: false,
            },
          },
        ],
      }),
    ).toBe(false);
  });

  test("barcode units are optional, and a scan quantity is an integer base string or null (VAN-009)", async () => {
    const boot = await read("bootstrap-response.json");
    const products = boot.products as Record<string, unknown>[];
    const first = products[0]!;
    const withUnits = (barcodeUnits: unknown) =>
      validate({ ...boot, products: [{ ...first, barcodeUnits }] });
    const legacy = { ...first };
    delete legacy.barcodeUnits;
    expect(validate({ ...boot, products: [legacy] })).toBe(true);
    expect(
      withUnits([
        { barcode: "4800000000017", uomCode: "PC", baseQuantity: null },
      ]),
    ).toBe(true);
    expect(
      withUnits([
        { barcode: "4800000000017", uomCode: "PC", baseQuantity: "1.5" },
      ]),
    ).toBe(false);
    expect(withUnits([{ barcode: "", uomCode: "PC", baseQuantity: "1" }])).toBe(
      false,
    );
    expect(withUnits([{ barcode: "4800000000017", uomCode: "PC" }])).toBe(
      false,
    );
  });

  test("payment methods and customer credit are optional and bounded (VAN-012)", async () => {
    const boot = await read("bootstrap-response.json");
    const policy = boot.policy as Record<string, unknown>;
    const methods = policy.paymentMethods as Record<string, unknown>[];
    const customers = boot.customers as Record<string, unknown>[];
    const withMethods = (paymentMethods: unknown) =>
      validate({ ...boot, policy: { ...policy, paymentMethods } });
    const withCredit = (credit: unknown) =>
      validate({ ...boot, customers: [{ ...customers[0]!, credit }] });
    const legacyPolicy = { ...policy };
    delete legacyPolicy.paymentMethods;
    const legacyCustomer = { ...customers[0]! };
    delete legacyCustomer.credit;
    expect(
      validate({ ...boot, policy: legacyPolicy, customers: [legacyCustomer] }),
    ).toBe(true);
    expect(withMethods([])).toBe(false);
    expect(withMethods([{ ...methods[0]!, kind: "voucher" }])).toBe(false);
    expect(withMethods([{ ...methods[0]!, code: "Cash!" }])).toBe(false);
    expect(withMethods([{ ...methods[1]!, referenceLabel: "" }])).toBe(false);
    expect(withMethods([{ ...methods[0]!, extra: true }])).toBe(false);
    expect(withCredit(null)).toBe(true);
    expect(withCredit({ termsDays: 30, availableMinor: "0" })).toBe(true);
    expect(withCredit({ termsDays: 0, availableMinor: "1" })).toBe(false);
    expect(withCredit({ termsDays: 181, availableMinor: "1" })).toBe(false);
    expect(withCredit({ termsDays: 30, availableMinor: "12.50" })).toBe(false);
    expect(withCredit({ termsDays: 30 })).toBe(false);
  });

  test("customer price list is optional: an id, or null for none (SP-0105)", async () => {
    const boot = await read("bootstrap-response.json");
    const customers = boot.customers as Record<string, unknown>[];
    const withList = (priceListId: unknown) =>
      validate({ ...boot, customers: [{ ...customers[0]!, priceListId }] });
    expect(withList("k57abc123priceListsXYZ")).toBe(true);
    expect(withList(null)).toBe(true);
    expect(withList("")).toBe(false);
    expect(withList(42)).toBe(false);
  });

  test("damage photo, approval policy and damage records are bounded (VAN-020)", async () => {
    const boot = await read("bootstrap-response.json");
    const policy = boot.policy as Record<string, unknown>;
    const damagePolicy = policy.damagePolicy as Record<string, unknown>;
    const records = boot.damageRecords as Record<string, unknown>[];
    const legacy = { ...boot, policy: { ...policy } };
    delete (legacy.policy as Record<string, unknown>).damagePolicy;
    delete (legacy as Record<string, unknown>).damageRecords;
    expect(validate(legacy)).toBe(true);
    const withPolicy = (next: unknown) =>
      validate({ ...boot, policy: { ...policy, damagePolicy: next } });
    expect(withPolicy({ ...damagePolicy, approvalFromUnits: 0 })).toBe(false);
    expect(withPolicy({ ...damagePolicy, photoMaxBytes: 200000 })).toBe(false);
    expect(
      withPolicy({ ...damagePolicy, photoRequiredReasons: ["dented"] }),
    ).toBe(false);
    const withRecord = (patch: Record<string, unknown>) =>
      validate({ ...boot, damageRecords: [{ ...records[0]!, ...patch }] });
    expect(withRecord({ status: "pending_approval" })).toBe(true);
    expect(
      withRecord({ status: "rejected", decisionNote: "Not damaged" }),
    ).toBe(true);
    expect(withRecord({ status: "waiting" })).toBe(false);
    expect(withRecord({ quantityBase: "1.5" })).toBe(false);

    const push = await read("push-request.json");
    const damage = (push.operations as Record<string, unknown>[])[2]!;
    const payload = damage.payload as Record<string, unknown>;
    const withPhoto = (photoSha256: unknown) =>
      validate({
        ...push,
        operations: [{ ...damage, payload: { ...payload, photoSha256 } }],
      });
    expect(withPhoto("A".repeat(64))).toBe(false);
    expect(withPhoto("ab")).toBe(false);
    const noPhoto = { ...payload };
    delete noPhoto.photoSha256;
    expect(
      validate({ ...push, operations: [{ ...damage, payload: noPhoto }] }),
    ).toBe(true);

    const evidence = await read("evidence-request.json");
    expect(validate({ ...evidence, contentType: "image/png" })).toBe(false);
    expect(validate({ ...evidence, dataBase64: "not base64!" })).toBe(false);
    expect(validate({ ...evidence, extra: 1 })).toBe(false);
  });

  test("void reasons and the void approval rule are optional and bounded (VAN-021)", async () => {
    const boot = await read("bootstrap-response.json");
    const policy = boot.policy as Record<string, unknown>;
    const approval = policy.voidApproval as Record<string, unknown>;
    const withPolicy = (extra: Record<string, unknown>) =>
      validate({ ...boot, policy: { ...policy, ...extra } });
    const legacy = { ...policy };
    delete legacy.voidReasons;
    delete legacy.voidApproval;
    expect(validate({ ...boot, policy: legacy })).toBe(true);
    expect(withPolicy({ voidApproval: { ...approval, key: null } })).toBe(true);
    expect(withPolicy({ voidReasons: [] })).toBe(false);
    expect(withPolicy({ voidReasons: ["mistake"] })).toBe(false);
    expect(withPolicy({ voidApproval: { ...approval, key: "short" } })).toBe(
      false,
    );
    expect(
      withPolicy({ voidApproval: { ...approval, thresholdMinor: 0 } }),
    ).toBe(false);
    const { key: _key, ...keyless } = approval;
    void _key;
    expect(withPolicy({ voidApproval: keyless })).toBe(false);
    expect(withPolicy({ voidApproval: { ...approval, extra: 1 } })).toBe(false);
  });

  test("void approval vectors match an independent HMAC implementation (VAN-021)", async () => {
    const vectors = (await read(VOID_VECTORS)) as {
      secret: string;
      tripId: string;
      key: string;
      cases: {
        receiptNumber: string;
        totalMinor: string;
        reasonCode: string;
        code: string;
      }[];
    };
    const key = createHmac("sha256", vectors.secret)
      .update(`sunpride/van-void-approval/v1|${vectors.tripId}`)
      .digest();
    expect(key.toString("base64url")).toBe(vectors.key);
    const boot = await read("bootstrap-response.json");
    expect(
      (boot.policy as { voidApproval: { key: string } }).voidApproval.key,
    ).toBe(vectors.key);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(3);
    for (const vector of vectors.cases) {
      const mac = createHmac("sha256", key)
        .update(
          `VOID|v1|${vectors.tripId}|${vector.receiptNumber}|${vector.totalMinor}|${vector.reasonCode}`,
        )
        .digest();
      const offset = mac[31]! & 0x0f;
      const binary = mac.readUInt32BE(offset) & 0x7fffffff;
      expect(String(binary % 100_000_000).padStart(8, "0")).toBe(vector.code);
    }
  });
  test("the cash reconciliation rule is optional and bounded (VAN-022)", async () => {
    const boot = await read("bootstrap-response.json");
    const policy = boot.policy as Record<string, unknown>;
    const cash = policy.cashReconciliation as Record<string, unknown>;
    const withCash = (extra: Record<string, unknown>) =>
      validate({ ...boot, policy: { ...policy, cashReconciliation: extra } });
    const legacy = { ...policy };
    delete legacy.cashReconciliation;
    expect(validate({ ...boot, policy: legacy })).toBe(true);
    expect(withCash({ ...cash, key: null })).toBe(true);
    expect(withCash({ ...cash, reasons: [] })).toBe(false);
    expect(withCash({ ...cash, reasons: ["shrug"] })).toBe(false);
    expect(withCash({ ...cash, key: "short" })).toBe(false);
    expect(withCash({ ...cash, toleranceMinor: 5000 })).toBe(false);
    expect(withCash({ ...cash, toleranceMinor: "-1" })).toBe(false);
    const { approvalRequired: _required, ...partial } = cash;
    void _required;
    expect(withCash(partial)).toBe(false);
    expect(withCash({ ...cash, extra: 1 })).toBe(false);
  });

  test("cash approval vectors match an independent HMAC implementation and differ from void keys (VAN-022)", async () => {
    const vectors = (await read(CASH_VECTORS)) as {
      secret: string;
      tripId: string;
      key: string;
      cases: {
        expectedMinor: string;
        declaredMinor: string;
        reasonCode: string;
        code: string;
      }[];
    };
    const key = createHmac("sha256", vectors.secret)
      .update(`sunpride/van-cash-approval/v1|${vectors.tripId}`)
      .digest();
    expect(key.toString("base64url")).toBe(vectors.key);
    const boot = await read("bootstrap-response.json");
    const policy = boot.policy as {
      cashReconciliation: { key: string };
      voidApproval: { key: string };
    };
    expect(policy.cashReconciliation.key).toBe(vectors.key);
    // Domain-separated: a void key (and so a void code) never approves cash.
    expect(policy.cashReconciliation.key).not.toBe(policy.voidApproval.key);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(3);
    for (const vector of vectors.cases) {
      const mac = createHmac("sha256", key)
        .update(
          `CASH|v1|${vectors.tripId}|${vector.expectedMinor}|${vector.declaredMinor}|${vector.reasonCode}`,
        )
        .digest();
      const offset = mac[31]! & 0x0f;
      const binary = mac.readUInt32BE(offset) & 0x7fffffff;
      expect(String(binary % 100_000_000).padStart(8, "0")).toBe(vector.code);
    }
  });
});
