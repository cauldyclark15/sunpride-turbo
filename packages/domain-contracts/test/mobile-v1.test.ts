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

  test("field order lines are bounded whole quantities in a unit, never prices", async () => {
    const original = await Bun.file(
      new URL("../fixtures/mobile-v1/push-order-request.json", import.meta.url),
    ).json();
    expect(validate(original), JSON.stringify(validate.errors)).toBe(true);
    const withLines = (lines: unknown) => {
      const altered = structuredClone(original);
      altered.operations[0].payload.activity.lines = lines;
      return altered;
    };
    const line = original.operations[0].payload.activity.lines[0];
    const lineless = structuredClone(original);
    delete lineless.operations[0].payload.activity.lines;
    expect(validate(lineless)).toBe(true);
    expect(validate(withLines([]))).toBe(false);
    expect(validate(withLines([{ ...line, quantity: 0 }]))).toBe(false);
    expect(validate(withLines([{ ...line, quantity: 1.5 }]))).toBe(false);
    expect(validate(withLines([{ ...line, quantity: 100_000 }]))).toBe(false);
    expect(validate(withLines([{ ...line, uom: "" }]))).toBe(false);
    expect(validate(withLines([{ ...line, unitPrice: 189 }]))).toBe(false);
    const missing = { ...line };
    delete missing.uom;
    expect(validate(withLines([missing]))).toBe(false);
    expect(validate(withLines(Array.from({ length: 101 }, () => line)))).toBe(
      false,
    );
  });

  test("bootstrap stays valid with or without the additive photoTypes field", async () => {
    const withTypes = await Bun.file(
      new URL(
        "../fixtures/mobile-v1/bootstrap-photo-types-response.json",
        import.meta.url,
      ),
    ).json();
    expect(validate(withTypes), JSON.stringify(validate.errors)).toBe(true);
    const withoutTypes = { ...withTypes };
    delete withoutTypes.photoTypes;
    expect(validate(withoutTypes)).toBe(true);
    const noLabel = structuredClone(withTypes);
    delete noLabel.photoTypes[0].label;
    expect(validate(noLabel)).toBe(false);
    const extra = structuredClone(withTypes);
    extra.photoTypes[0].required = true;
    expect(validate(extra)).toBe(false);
    const emptyCode = structuredClone(withTypes);
    emptyCode.photoTypes[0].code = "";
    expect(validate(emptyCode)).toBe(false);
  });

  test("bootstrap stays valid with or without the additive activityRules field", async () => {
    const withRules = await Bun.file(
      new URL(
        "../fixtures/mobile-v1/bootstrap-activity-rules-response.json",
        import.meta.url,
      ),
    ).json();
    expect(validate(withRules), JSON.stringify(validate.errors)).toBe(true);
    const withoutRules = { ...withRules };
    delete withoutRules.activityRules;
    expect(validate(withoutRules)).toBe(true);
    const noVersion = structuredClone(withRules);
    delete noVersion.activityRules[0].version;
    expect(validate(noVersion)).toBe(false);
    const extra = structuredClone(withRules);
    extra.activityRules[0].activities[0].label = "Merchandising";
    expect(validate(extra)).toBe(false);
    const notBoolean = structuredClone(withRules);
    notBoolean.activityRules[0].activities[0].required = "yes";
    expect(validate(notBoolean)).toBe(false);
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

  test("keeps outlet territory fields additive, paired and nonempty", async () => {
    const original = await Bun.file(
      new URL("../fixtures/mobile-v1/bootstrap-response.json", import.meta.url),
    ).json();
    const outlet = original.outlets[0];
    const withOutlet = (value: Record<string, unknown>) => ({
      ...original,
      outlets: [value],
    });
    expect(validate(original), JSON.stringify(validate.errors)).toBe(true);
    const withoutTerritory = { ...outlet };
    delete withoutTerritory.territoryId;
    delete withoutTerritory.territoryCode;
    expect(validate(withOutlet(withoutTerritory))).toBe(true);
    expect(
      validate(
        withOutlet({ ...withoutTerritory, territoryId: outlet.territoryId }),
      ),
    ).toBe(false);
    expect(
      validate(
        withOutlet({
          ...withoutTerritory,
          territoryCode: outlet.territoryCode,
        }),
      ),
    ).toBe(false);
    for (const field of ["territoryId", "territoryCode"]) {
      expect(validate(withOutlet({ ...outlet, [field]: "" }))).toBe(false);
      expect(validate(withOutlet({ ...outlet, [field]: null }))).toBe(false);
    }
  });

  test("keeps daily-route outlet fields additive; a pin is both coordinates or none", async () => {
    const original = await Bun.file(
      new URL("../fixtures/mobile-v1/bootstrap-response.json", import.meta.url),
    ).json();
    const outlet = original.outlets[0];
    expect(validate(original), JSON.stringify(validate.errors)).toBe(true);
    const withOutlet = (value: Record<string, unknown>) => ({
      ...original,
      outlets: [value],
    });
    expect(
      validate(withOutlet({ id: outlet.id, name: outlet.name, routeId: null })),
    ).toBe(true);
    const latitudeOnly = { ...outlet };
    delete latitudeOnly.longitude;
    expect(validate(withOutlet(latitudeOnly))).toBe(false);
    expect(validate(withOutlet({ ...outlet, latitude: 91 }))).toBe(false);
    expect(validate(withOutlet({ ...outlet, address: "" }))).toBe(false);
  });
});
