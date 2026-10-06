import { describe, expect, test } from "bun:test";
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
const names = (
  await Array.fromAsync(
    new Bun.Glob("*.json").scan({ cwd: fixtureDir.pathname }),
  )
).sort();

describe("van v1 contract fixtures", () => {
  test("covers every envelope type", async () => {
    const types = new Set<string>();
    for (const name of names) types.add(String((await read(name)).type));
    expect([...types].sort()).toEqual([
      "error.response",
      "van.bootstrap.request",
      "van.bootstrap.response",
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
});
