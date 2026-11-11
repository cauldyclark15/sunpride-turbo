import { describe, expect, test } from "bun:test";
import {
  CUSTOMER_HEADERS,
  CUSTOMER_TEMPLATE_SPEC,
  customerTemplateCsv,
  headerError,
  phMobile,
  validateCustomerRowsSync,
  composeAddress,
} from "../src/customers.js";

const dir = new URL(".", import.meta.url).pathname;
const example = () => ({
  rowNumber: 2,
  values: Object.fromEntries(
    CUSTOMER_TEMPLATE_SPEC.map((c) => [c.column, c.example]),
  ),
});

describe("SP-0169 customer template", () => {
  test("spec mirrors the JSON sent to the client", async () => {
    const sent = await Bun.file(`${dir}customers-template-spec.json`).json();
    expect(CUSTOMER_TEMPLATE_SPEC).toEqual(sent);
  });
  test("generated CSV is byte-identical to the client's template", async () => {
    const sent = await Bun.file(`${dir}sunpride-customers-template.csv`).text();
    expect(customerTemplateCsv()).toBe(sent);
    expect(CUSTOMER_HEADERS.length).toBe(18);
  });
  test("the template's own example row is valid", () => {
    expect(validateCustomerRowsSync([example()])).toEqual([]);
    expect(headerError([...CUSTOMER_HEADERS])).toBeNull();
  });
  test("header must match exactly and in order", () => {
    const swapped = [...CUSTOMER_HEADERS];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(headerError(swapped)?.code).toBe("header_mismatch");
    expect(headerError(CUSTOMER_HEADERS.slice(1))?.message).toContain(
      "missing customer_code",
    );
  });
  test("row rules report code, column, row and value", () => {
    const r = example();
    Object.assign(r.values, {
      customer_code: "bad code!",
      status: "closed",
      owner_phone: "12345",
      latitude: "95",
      longitude: "",
      visit_frequency_days: "0",
      province: "",
    });
    const errors = validateCustomerRowsSync([r]);
    const codes = errors.map((e) => `${e.column}:${e.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "customer_code:invalid_code",
        "status:invalid_status",
        "owner_phone:invalid_phone",
        "longitude:coordinates_incomplete",
        "latitude:invalid_coordinates",
        "visit_frequency_days:invalid_visit_frequency",
        "province:required",
      ]),
    );
    expect(errors.find((e) => e.code === "invalid_status")).toMatchObject({
      rowNumber: 2,
      value: "closed",
    });
  });
  test("duplicate codes are case-insensitive and point at the first row", () => {
    const a = example(),
      b = { ...example(), rowNumber: 3 };
    b.values = { ...b.values, customer_code: "gt-000123" };
    const [e] = validateCustomerRowsSync([a, b]);
    expect(e).toMatchObject({
      rowNumber: 3,
      column: "customer_code",
      code: "duplicate_in_file",
    });
    expect(e.message).toContain("row 2");
  });
  test("PH mobile normalisation", () => {
    expect(phMobile("0917 123 4567")).toBe("09171234567");
    expect(phMobile("+639171234567")).toBe("09171234567");
    expect(phMobile("0321234567")).toBeNull();
  });
  test("address joins the parts", () => {
    expect(composeAddress(example())).toBe(
      "123 P. del Rosario St., Brgy. Kamputhaw, Cebu City, Cebu",
    );
  });
});
