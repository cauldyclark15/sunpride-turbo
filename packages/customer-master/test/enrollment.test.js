import { expect, test } from "bun:test";
import {
  enrollmentFields,
  validateEnrollment,
  enrollmentRequired,
} from "../src/enrollment.js";
const key = (/** @type {number} */ n) => `cf_${String(n).padStart(32, "0")}`;
const fields = ["text", "number", "date", "choice", "boolean", "photo"].map(
  (kind, i) => ({
    key: key(i),
    label: kind,
    kind,
    choices: kind === "choice" ? ["A", "B"] : [],
    requiredChannels: ["10"],
    requiredTypes: ["Corporate"],
  }),
);
test("SP-0229 six types; explicit No and zero; blanks optional outside either selected audience", () => {
  expect(enrollmentFields(fields)).toEqual(fields);
  expect(enrollmentRequired(fields[0], { distributionChannelCode: "10" })).toBe(
    true,
  );
  expect(enrollmentRequired(fields[0], { typeOfBusiness: "Corporate" })).toBe(
    true,
  );
  expect(
    validateEnrollment(
      fields,
      {},
      { distributionChannelCode: "41", typeOfBusiness: "Sole" },
    ).errors,
  ).toEqual([]);
  expect(
    validateEnrollment(fields, {}, { distributionChannelCode: "10" }).errors,
  ).toHaveLength(6);
  const values = {
    [key(0)]: "Desk",
    [key(1)]: "0",
    [key(2)]: "2024-02-29",
    [key(3)]: "A",
    [key(4)]: "false",
    [key(5)]: "data:image/jpeg;base64,/9j/2Q==",
  };
  expect(
    validateEnrollment(fields, values, { distributionChannelCode: "10" })
      .errors,
  ).toEqual([]);
  expect(
    validateEnrollment(
      fields,
      { ...values, [key(2)]: "2026-02-30" },
      { distributionChannelCode: "10" },
    ).errors[0].field,
  ).toBe(`customFields.${key(2)}`);
  for (const s of ["-", "NaN", "Infinity", "1e40", "1,000"])
    expect(
      validateEnrollment([fields[1]], { [key(1)]: s }, {}).errors,
    ).toHaveLength(1);
  expect(
    validateEnrollment(fields, { ...values, [key(4)]: "-" }, {}).errors,
  ).toHaveLength(1);
  expect(
    validateEnrollment(
      fields,
      { ...values, [key(5)]: "data:text/html;base64,AAAA" },
      {},
    ).errors,
  ).toHaveLength(1);
  expect(
    validateEnrollment(
      fields,
      {
        ...values,
        [key(5)]: "data:image/jpeg;base64,/9j/" + "A".repeat(150000),
      },
      {},
    ).errors,
  ).toHaveLength(1);
  expect(
    validateEnrollment(fields, { [key(7)]: "unknown" }, {}).errors[0].code,
  ).toBe("unknown");
});
test("SP-0229 field identity and bounded choices are not silently repaired", () => {
  for (const invalid of [
    [fields[0], fields[0]],
    [{ ...fields[0], key: "field-name" }],
    [{ ...fields[3], choices: [] }],
    [{ ...fields[0], label: " " }],
    [{ ...fields[0], kind: "html" }],
  ])
    expect(() => enrollmentFields(invalid)).toThrow();
});
