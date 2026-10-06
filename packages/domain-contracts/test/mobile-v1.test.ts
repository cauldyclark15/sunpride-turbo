import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schemas/mobile-v1.schema.json";
import {
  isMobileV1Envelope,
  parseMobileV1Response,
  type BootstrapResponse,
  type PricingV1,
} from "../src/index";

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

describe("mobile v1 governed bootstrap pricing", () => {
  async function readPricing(): Promise<
    BootstrapResponse & { pricing: PricingV1 }
  > {
    const fixture: unknown = await Bun.file(
      new URL(
        "../fixtures/mobile-v1/bootstrap-pricing-response.json",
        import.meta.url,
      ),
    ).json();
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(isMobileV1Envelope(fixture)).toBe(true);
    const response = parseMobileV1Response(fixture);
    if (response.type !== "bootstrap.response" || !response.pricing)
      throw new Error("Expected a bootstrap pricing fixture");
    return { ...response, pricing: response.pricing };
  }

  function expectRejected(value: unknown, context?: string) {
    expect(validate(value), context).toBe(false);
    expect(isMobileV1Envelope(value), context).toBe(false);
    expect(() => parseMobileV1Response(value)).toThrow();
  }

  function pricingObjects(
    value: unknown,
    path = "pricing",
  ): Array<{ path: string; object: Record<string, unknown> }> {
    if (Array.isArray(value))
      return value.flatMap((item, index) =>
        pricingObjects(item, `${path}[${index}]`),
      );
    if (!value || typeof value !== "object") return [];
    const object = value as Record<string, unknown>;
    return [
      { path, object },
      ...Object.entries(object).flatMap(([key, child]) =>
        pricingObjects(child, `${path}.${key}`),
      ),
    ];
  }

  test("pricing fixture validates and round-trips all three governed rule kinds", async () => {
    const original = await readPricing();
    const parsed = parseMobileV1Response(original);
    expect(parsed).toBe(original);
    if (parsed.type !== "bootstrap.response")
      throw new Error("Expected bootstrap response");
    expect(parsed.pricing).toEqual(original.pricing);
    expect(parsed.pricing!.priceLists).toHaveLength(2);
    expect(parsed.pricing!.promotions.map(({ rule }) => rule.kind)).toEqual([
      "buy_x_get_y",
      "percent_off",
      "bundle",
    ]);
    expect(parsed.appConfig.priceAvailability).toBe("unavailable");
    expect(parsed.appConfig.promotionsAvailability).toBe("unavailable");
    for (const list of original.pricing.priceLists) {
      expect(list.currency).toBe("PHP");
      expect(list.vatInclusive).toBe(true);
      expect(new Set(list.lines.map(({ uomCode }) => uomCode))).toEqual(
        new Set(["PC", "CASE"]),
      );
      for (const line of list.lines) {
        const product = original.productCatalog.find(
          ({ id }) => id === line.productId,
        );
        expect(product).toBeDefined();
        expect(product!.sellingUoms!.map(({ code }) => code)).toContain(
          line.uomCode,
        );
      }
    }
    expect(
      original.pricing.outletPriceLists.map(({ outletId }) => outletId),
    ).toEqual(original.outlets.map(({ id }) => id));
    for (const mapping of original.pricing.outletPriceLists)
      expect(
        original.pricing.priceLists.map(({ priceListId }) => priceListId),
      ).toContain(mapping.priceListId);
  });

  test("pricing omission still validates older bootstraps; explicit null does not", async () => {
    const legacy: unknown = await Bun.file(
      new URL("../fixtures/mobile-v1/bootstrap-response.json", import.meta.url),
    ).json();
    expect(validate(legacy), JSON.stringify(validate.errors)).toBe(true);
    expect(isMobileV1Envelope(legacy)).toBe(true);
    const parsed = parseMobileV1Response(legacy);
    expect(parsed === legacy).toBe(true);
    if (parsed.type !== "bootstrap.response")
      throw new Error("Expected bootstrap response");
    expect(parsed.pricing).toBeUndefined();
    const withoutPricing: BootstrapResponse = await readPricing();
    delete withoutPricing.pricing;
    expect(validate(withoutPricing), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(isMobileV1Envelope(withoutPricing)).toBe(true);
    expect(parseMobileV1Response(withoutPricing)).toBe(withoutPricing);
    expectRejected({ ...withoutPricing, pricing: null });
  });

  test("unit prices are nonnegative whole centavos, including zero", async () => {
    const original = await readPricing();
    for (const unitPriceMinor of [-1, 12.5]) {
      const changed = structuredClone(original);
      changed.pricing.priceLists[0]!.lines[0]!.unitPriceMinor = unitPriceMinor;
      expectRejected(changed, `unitPriceMinor=${unitPriceMinor}`);
    }
    original.pricing.priceLists[0]!.lines[0]!.unitPriceMinor = 0;
    expect(validate(original), JSON.stringify(validate.errors)).toBe(true);
    expect(parseMobileV1Response(original)).toBe(original);
  });

  test("unknown rule kinds fail closed in schema and runtime", async () => {
    const changed = await readPricing();
    Object.assign(changed.pricing.promotions[0]!.rule, {
      kind: "future_discount",
    });
    expectRejected(changed);
  });

  test("percent discounts require integer basis points from 1 through 10000", async () => {
    const original = await readPricing();
    for (const percentOffBasisPoints of [0, 10001, 500.5, 1, 10000]) {
      const changed = structuredClone(original);
      const rule = changed.pricing.promotions[1]!.rule;
      if (rule.kind !== "percent_off")
        throw new Error("Expected percent-off fixture rule");
      rule.percentOffBasisPoints = percentOffBasisPoints;
      if ([1, 10000].includes(percentOffBasisPoints)) {
        expect(validate(changed), JSON.stringify(validate.errors)).toBe(true);
        expect(parseMobileV1Response(changed)).toBe(changed);
      } else expectRejected(changed, `basisPoints=${percentOffBasisPoints}`);
    }
  });

  test("every pricing object rejects extra fields and omission of any listed field", async () => {
    const changed = await readPricing();
    for (const { path, object } of pricingObjects(changed.pricing)) {
      object.invented = true;
      expectRejected(changed, `${path}.invented`);
      delete object.invented;
      for (const [key, value] of Object.entries(object)) {
        delete object[key];
        expectRejected(changed, `${path}.${key} omitted`);
        object[key] = value;
      }
    }
    expect(validate(changed), JSON.stringify(validate.errors)).toBe(true);
  });

  test("promotion units and bundles enforce whole quantities, component bounds and minor amounts", async () => {
    const original = await readPricing();
    for (const index of [0, 1, 2]) {
      for (const quantity of [0, 1.5]) {
        const changed = structuredClone(original);
        const rule = changed.pricing.promotions[index]!.rule;
        const units =
          rule.kind === "buy_x_get_y"
            ? [rule.buy, rule.free]
            : rule.kind === "percent_off"
              ? [rule.item]
              : rule.components;
        for (const unit of units) {
          const previous = unit.quantity;
          unit.quantity = quantity;
          expectRejected(changed, `rule ${index} quantity=${quantity}`);
          unit.quantity = previous;
        }
      }
    }
    for (const size of [1, 2, 6, 7]) {
      const changed = structuredClone(original);
      const rule = changed.pricing.promotions[2]!.rule;
      if (rule.kind !== "bundle")
        throw new Error("Expected bundle fixture rule");
      rule.components = Array.from({ length: size }, () => rule.components[0]!);
      if ([2, 6].includes(size)) {
        expect(validate(changed), JSON.stringify(validate.errors)).toBe(true);
        expect(isMobileV1Envelope(changed)).toBe(true);
      } else expectRejected(changed, `bundle components=${size}`);
    }
    for (const bundlePriceMinor of [-1, 12.5, 0]) {
      const changed = structuredClone(original);
      const rule = changed.pricing.promotions[2]!.rule;
      if (rule.kind !== "bundle")
        throw new Error("Expected bundle fixture rule");
      rule.bundlePriceMinor = bundlePriceMinor;
      if (bundlePriceMinor === 0)
        expect(validate(changed), JSON.stringify(validate.errors)).toBe(true);
      else expectRejected(changed, `bundlePriceMinor=${bundlePriceMinor}`);
    }
  });

  test("currency, VAT and effective times retain their wire types", async () => {
    const original = await readPricing();
    for (const currency of ["php", "PH", "PHPP", "P1P", "PHP\n"]) {
      const changed = structuredClone(original);
      changed.pricing.priceLists[0]!.currency = currency;
      expectRejected(changed, `currency=${currency}`);
    }
    const wrongVat = structuredClone(original);
    Object.assign(wrongVat.pricing.priceLists[0]!, { vatInclusive: "true" });
    expectRejected(wrongVat);
    for (const field of ["effectiveFrom", "effectiveTo"] as const) {
      const changedLine = structuredClone(original);
      changedLine.pricing.priceLists[0]!.lines[0]![field] = 1.5;
      expectRejected(changedLine, `line.${field}`);
      const changedPromotion = structuredClone(original);
      changedPromotion.pricing.promotions[0]![field] = 1.5;
      expectRejected(changedPromotion, `promotion.${field}`);
    }
    original.pricing.priceLists[0]!.lines[0]!.effectiveTo = original.serverTime;
    original.pricing.promotions[0]!.effectiveTo = null;
    expect(validate(original), JSON.stringify(validate.errors)).toBe(true);
  });

  test("pricing arrays enforce working-set bounds", async () => {
    const original = await readPricing();
    for (const [key, maxItems] of [
      ["priceLists", 20],
      ["outletPriceLists", 600],
      ["promotions", 100],
    ] as const) {
      const changed = structuredClone(original);
      Object.assign(changed.pricing, {
        [key]: Array.from(
          { length: maxItems + 1 },
          () => original.pricing[key][0],
        ),
      });
      expectRejected(changed, `${key} maxItems=${maxItems}`);
    }
    const tooManyLines = structuredClone(original);
    tooManyLines.pricing.priceLists[0]!.lines = Array.from(
      { length: 2001 },
      () => original.pricing.priceLists[0]!.lines[0]!,
    );
    expectRejected(tooManyLines, "lines maxItems=2000");
    const empty = {
      ...original,
      pricing: { priceLists: [], outletPriceLists: [], promotions: [] },
    };
    expect(validate(empty), JSON.stringify(validate.errors)).toBe(true);
  });
});

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

  test("bootstrap stays valid with or without the additive accountSummaries field", async () => {
    const withSummaries = await Bun.file(
      new URL(
        "../fixtures/mobile-v1/bootstrap-account-summary-response.json",
        import.meta.url,
      ),
    ).json();
    expect(validate(withSummaries), JSON.stringify(validate.errors)).toBe(true);
    const withoutSummaries = { ...withSummaries };
    delete withoutSummaries.accountSummaries;
    expect(validate(withoutSummaries)).toBe(true);
    // A withheld account carries explicit nulls, never omitted figures.
    const withheld = structuredClone(withSummaries);
    Object.assign(withheld.accountSummaries[0], {
      availability: "withheld",
      creditLimitMinor: null,
      sales: null,
      openOrders: null,
    });
    expect(validate(withheld), JSON.stringify(validate.errors)).toBe(true);
    const omitted = structuredClone(withheld);
    delete omitted.accountSummaries[0].sales;
    expect(validate(omitted)).toBe(false);
    const fractional = structuredClone(withSummaries);
    fractional.accountSummaries[0].sales.amountMinor = 12.5;
    expect(validate(fractional)).toBe(false);
    const balance = structuredClone(withSummaries);
    balance.accountSummaries[0].arBalanceMinor = 100;
    expect(validate(balance)).toBe(false);
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
