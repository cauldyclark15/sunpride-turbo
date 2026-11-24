import { expect, test } from "bun:test";
import {
  CUSTOMER_FIELDS,
  FIELD_CAPTURE,
  validateCustomer,
} from "../src/index.js";
import { buildParity } from "../scripts/android-parity.js";

const fixture = await buildParity();
const sample = fixture.cases.find(
  (c) => c.name === "field complete for CDM review",
);
if (!sample) throw new Error("Missing field fixture");
/** @param {Record<string, any>} input */
const validate = (input) =>
  validateCustomer(input, {
    level: "field",
    lists: fixture.lists,
    geography: sample.geography,
  });
const required = [
  "registeredName",
  "customerName",
  "mobileNo",
  "taxClassificationCode",
  "countryCode",
  "salesOfficeCode",
  "paymentTermsCode",
  "pricingProcedureCode",
  "deliveringPlantCode",
  "regionCode",
  "provinceCode",
  "municipalityCode",
  "barangayCode",
  "street1",
  "salesOrgCode",
  "distributionChannelCode",
  "customerGroup1Code",
  "customerGroup2Code",
  "customerGroupCode",
  "typeOfBusiness",
];

test("SP-0220 field save no longer requires the separate Customer Address", () => {
  for (const blank of [undefined, null, "", " \t "]) {
    const r = validate({ ...sample.input, customerAddress: blank });
    expect(r.errors.map((e) => e.field)).not.toContain("customerAddress");
  }
});

for (const key of required) {
  test(`field save refuses missing, empty and whitespace ${key}`, () => {
    for (const blank of [undefined, null, "", " \t "]) {
      const r = validate({ ...sample.input, [key]: blank });
      expect(r.ok).toBe(false);
      expect(r.errors).toContainEqual(
        expect.objectContaining({ field: key, code: "required" }),
      );
    }
  });
}

test("SP-0184 field capture covers the full sheet and uses complete-level checks", () => {
  expect(FIELD_CAPTURE).toEqual(CUSTOMER_FIELDS.map((field) => field.key));
  for (const example of fixture.cases.filter((c) => c.level === "field")) {
    const field = validateCustomer(example.input, {
      level: "field",
      lists: fixture.lists,
      geography: example.geography,
    });
    const complete = validateCustomer(example.input, {
      level: "complete",
      lists: fixture.lists,
      geography: example.geography,
    });
    expect(field.ok).toBe(complete.ok);
    expect(field.errors).toEqual(complete.errors);
    expect(field.value).toEqual(complete.value);
  }
});

test("field requires coordinates and all former office fields, but not optional fields", () => {
  expect(validate(sample.input).errors).toEqual([]);
  const r = validate({ ...sample.input, latitude: null, longitude: null });
  expect(r.errors.map((e) => [e.field, e.code])).toEqual([
    ["coordinates", "required"],
  ]);
  expect(FIELD_CAPTURE).toContain("taxClassificationCode");
  const old = fixture.cases.find(
    (c) => c.name === "field complete without office fields",
  );
  expect(old?.expected.ok).toBe(false);
  expect(
    validateCustomer(sample.input, { level: "complete", lists: fixture.lists })
      .ok,
  ).toBe(true);
  expect(
    validateCustomer(
      { customerName: "Office draft" },
      { level: "draft", lists: [] },
    ).ok,
  ).toBe(true);
});

test("field groups are required only when applicable; agents must complete conditional ADP", () => {
  const services = {
    ...sample.input,
    distributionChannelCode: "50",
    customerGroup1Code: null,
    customerGroup2Code: null,
  };
  expect(validate(services).errors).toEqual([]);
  const food = {
    ...services,
    distributionChannelCode: "20",
    customerGroup1Code: "FRT",
  };
  expect(validate(food).errors).toEqual([]);
  // Use the actual configured chain.
  const g1 = fixture.lists.find(
    (r) =>
      r.list === "customer_group_1" &&
      r.channelCode === "40" &&
      r.salesOrgCode === "1000",
  );
  const g2 = fixture.lists.find(
    (r) =>
      r.list === "customer_group_2" &&
      r.channelCode === "40" &&
      r.salesOrgCode === "1000" &&
      r.group1Code === g1?.code,
  );
  const adp = {
    ...services,
    distributionChannelCode: "40",
    customerGroup1Code: g1?.code ?? null,
    customerGroup2Code: g2?.code ?? null,
  };
  expect(
    validate(adp)
      .errors.filter((e) => e.code === "required")
      .map((e) => e.field),
  ).toEqual(fixture.fields.filter((f) => f.adp).map((f) => f.key));
  const completeAdp = fixture.cases.find(
    (c) => c.name === "field complete ADP",
  );
  if (!completeAdp) throw new Error("Missing ADP fixture");
  for (const field of fixture.fields.filter((f) => f.adp))
    for (const blank of [undefined, null, "", " "])
      expect(
        validate({ ...completeAdp.input, [field.key]: blank }).errors,
      ).toContainEqual(
        expect.objectContaining({ field: field.key, code: "required" }),
      );
});

test("field requires valid nested delivery entries, including explicit JSON nulls", () => {
  for (const blank of [undefined, null, []])
    expect(validate({ ...sample.input, shipTos: blank }).errors).toContainEqual(
      expect.objectContaining({ code: "ship_to_required" }),
    );
  for (const field of fixture.fields.filter((f) => f.shipTo && f.required))
    for (const blank of [undefined, null, "", " "])
      expect(
        validate({
          ...sample.input,
          shipTos: [{ ...sample.input.shipTos[0], [field.key]: blank }],
        }).errors,
      ).toContainEqual(
        expect.objectContaining({
          field: `shipTos[0].${field.key}`,
          code: "required",
        }),
      );
});
