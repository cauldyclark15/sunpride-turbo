import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schemas/mobile-v1.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const fixtureNames = [
  "bootstrap-request",
  "bootstrap-response",
  "pull-response",
  "push-request",
  "push-response",
];

describe("mobile v1 canonical contract", () => {
  for (const name of fixtureNames) {
    test(`validates ${name}`, async () => {
      const fixture = await Bun.file(
        new URL(`../fixtures/${name}.json`, import.meta.url),
      ).json();
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    });
  }

  test("rejects an unknown version, operation and extra fields", async () => {
    const original = await Bun.file(
      new URL("../fixtures/push-request.json", import.meta.url),
    ).json();
    for (const altered of [
      { ...original, contractVersion: 2 },
      {
        ...original,
        operations: [{ ...original.operations[0], kind: "order.create" }],
      },
      { ...original, employeeId: "claimed-person" },
      {
        ...original,
        operations: [
          {
            ...original.operations[0],
            payload: {
              ...original.operations[0].payload,
              withinGeofence: true,
            },
          },
        ],
      },
    ]) {
      expect(validate(altered)).toBe(false);
    }
  });

  test("keeps unplannedReason additive and validates its bounds", async () => {
    const original = await Bun.file(
      new URL("../fixtures/push-request.json", import.meta.url),
    ).json();
    const check = original.operations[0];
    expect(validate(original)).toBe(true);
    const plannedPayload = { ...check.payload };
    delete plannedPayload.unplannedReason;
    const planned = {
      ...original,
      operations: [
        {
          ...check,
          payload: { ...plannedPayload, plannedVisitId: "planned-1" },
        },
      ],
    };
    expect(validate(planned)).toBe(true);
    const oversized = {
      ...original,
      operations: [
        {
          ...check,
          payload: { ...check.payload, unplannedReason: "x".repeat(501) },
        },
      ],
    };
    expect(validate(oversized)).toBe(false);
  });

  test("call sheet lines carry every measure, null or a bounded whole number", async () => {
    const original = await Bun.file(
      new URL(
        "../fixtures/mobile-v1/push-call-sheet-request.json",
        import.meta.url,
      ),
    ).json();
    expect(validate(original), JSON.stringify(validate.errors)).toBe(true);
    const withLine = (line: Record<string, unknown>) => {
      const altered = structuredClone(original);
      altered.operations[0].payload.activity.lines = [line];
      return altered;
    };
    const line = original.operations[0].payload.activity.lines[0];
    expect(validate(withLine({ ...line, take: null }))).toBe(true);
    const missing = { ...line };
    delete missing.offtake;
    expect(validate(withLine(missing))).toBe(false);
    expect(validate(withLine({ ...line, order: -1 }))).toBe(false);
    expect(validate(withLine({ ...line, order: 1.5 }))).toBe(false);
    expect(validate(withLine({ ...line, order: 1_000_001 }))).toBe(false);
    expect(validate(withLine({ ...line, remarks: "x" }))).toBe(false);
    const empty = structuredClone(original);
    empty.operations[0].payload.activity.lines = [];
    expect(validate(empty)).toBe(false);
  });

  test("bootstrap stays valid with or without the additive callSheets field", async () => {
    const withSheets = await Bun.file(
      new URL(
        "../fixtures/mobile-v1/bootstrap-call-sheet-response.json",
        import.meta.url,
      ),
    ).json();
    expect(validate(withSheets), JSON.stringify(validate.errors)).toBe(true);
    const withoutSheets = { ...withSheets };
    delete withoutSheets.callSheets;
    expect(validate(withoutSheets)).toBe(true);
    const noName = structuredClone(withSheets);
    noName.callSheets[0].header.accountName = "";
    expect(validate(noName)).toBe(false);
  });
});
