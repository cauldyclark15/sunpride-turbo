import { describe, expect, test } from "bun:test";
import {
  CUSTOMER_NAME_FIELDS,
  formatCustomerName,
  validateCustomer,
  validateCustomerName,
} from "../src/index.js";

describe("SP-0240 individual customer names", () => {
  test("first and last required; middle optional; trim without splitting multiword names", () => {
    expect(CUSTOMER_NAME_FIELDS.map((f) => [f.label, f.required])).toEqual([
      ["First Name", true],
      ["Middle Name", false],
      ["Last Name", true],
    ]);
    expect(
      validateCustomerName({
        firstName: "  María José ",
        lastName: " de la Cruz ",
      }),
    ).toEqual({
      value: {
        firstName: "María José",
        middleName: null,
        lastName: "de la Cruz",
        customerName: "María José de la Cruz",
      },
      errors: [],
    });
    expect(
      formatCustomerName({
        firstName: "Anne-Marie",
        middleName: "Peña",
        lastName: "O’Neil",
      }),
    ).toBe("Anne-Marie Peña O’Neil");
    for (const blank of [undefined, null, "", " \t "]) {
      expect(
        validateCustomerName({
          firstName: blank,
          middleName: "",
          lastName: blank,
        }).errors.map((e) => e.field),
      ).toEqual(["firstName", "lastName"]);
    }
  });
  test("bounds complete names without silently truncating or accepting non-text values", () => {
    expect(
      validateCustomerName({
        firstName: "A".repeat(100),
        middleName: "B".repeat(100),
        lastName: "C",
      }).errors,
    ).toContainEqual(
      expect.objectContaining({ field: "lastName", code: "too_long" }),
    );
    expect(
      validateCustomerName({ firstName: 42, lastName: "Cruz" }).errors[0]
        ?.field,
    ).toBe("firstName");
  });
  test("the canonical validator derives a consistent display name and leaves legacy names unparsed", () => {
    const r = validateCustomer(
      {
        customerName: "WRONG ORDER",
        firstName: " Rosa ",
        middleName: " M. ",
        lastName: " Cruz ",
      },
      { level: "draft", lists: [] },
    );
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({
      firstName: "Rosa",
      middleName: "M.",
      lastName: "Cruz",
      customerName: "Rosa M. Cruz",
    });
    const legacy = validateCustomer(
      { customerName: "CRUZ, Rosa M." },
      { level: "draft", lists: [] },
    );
    expect(legacy.ok).toBe(true);
    expect(legacy.value.customerName).toBe("CRUZ, Rosa M.");
    expect(legacy.value).not.toHaveProperty("firstName");
    expect(
      validateCustomer(
        { customerName: "Only full name" },
        { level: "complete", lists: [], requireNameParts: true },
      ).errors.map((e) => e.field),
    ).toEqual(expect.arrayContaining(["firstName", "lastName"]));
  });
});
