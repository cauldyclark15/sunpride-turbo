import { expect, test } from "bun:test";
import { FIELD_CAPTURE, validateCustomer } from "../src/index.js";
import { buildParity } from "../scripts/android-parity.js";

const fixture = await buildParity();
const sample = fixture.cases.find(
  (c) => c.name === "field complete without office fields",
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
  "customerAddress",
  "mobileNo",
  "regionCode",
  "provinceCode",
  "municipalityCode",
  "barangayCode",
  "postalCode",
  "salesOrgCode",
  "distributionChannelCode",
  "customerGroup1Code",
  "customerGroup2Code",
  "customerGroupCode",
  "typeOfBusiness",
];

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

test("field requires coordinates, but not optional or office-only fields", () => {
  expect(validate(sample.input).errors).toEqual([]);
  const r = validate({ ...sample.input, latitude: null, longitude: null });
  expect(r.errors.map((e) => [e.field, e.code])).toEqual([
    ["coordinates", "required"],
  ]);
  expect(FIELD_CAPTURE).not.toContain("taxClassificationCode");
  expect(
    validateCustomer(sample.input, { level: "complete", lists: fixture.lists })
      .ok,
  ).toBe(false);
  expect(
    validateCustomer(
      { customerName: "Office draft" },
      { level: "draft", lists: [] },
    ).ok,
  ).toBe(true);
});

test("field groups are required only when applicable; ADP stays with the office", () => {
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
  expect(validate(adp).errors).toEqual([]);
});
