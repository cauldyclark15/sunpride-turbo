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
});
