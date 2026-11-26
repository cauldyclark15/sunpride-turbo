import { describe, expect, test } from "bun:test";
import {
  FIELDS,
  SECTIONS,
  formatAddress,
  normalizePhMobile,
  normalizeTin,
  optionLabel,
  referenceIndex,
  shipToFromCustomer,
  validateCustomer,
} from "../src/index.js";
import { referenceRows } from "../../db/src/customer-reference.js";

const json = JSON.parse(
  await Bun.file(
    new URL(
      "../../db/reference/sunpride-customer-master-2026-11-10.json",
      import.meta.url,
    ),
  ).text(),
);
const lists = referenceRows(json);
const index = referenceIndex(lists);
const cebu = {
  region: { code: "0700000000", name: "Region VII (Central Visayas)" },
  province: { code: "0702200000", name: "Cebu", regionCode: "0700000000" },
  municipality: {
    code: "0730600000",
    name: "City of Cebu",
    provinceCode: "0702200000",
    regionCode: "0700000000",
  },
  barangay: {
    code: "0730600003",
    name: "Apas",
    municipalityCode: "0730600000",
  },
  postalCodes: ["6000"],
};
/** @param {Record<string, any>} [over] */
const complete = (over = {}) => ({
  registeredName: "Aling Nena Store Inc.",
  customerName: "Aling Nena Sari-sari",
  customerAddress: "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
  mobileNo: "09171234567",
  taxClassificationCode: "1",
  countryCode: "PH",
  regionCode: "0700000000",
  provinceCode: "0702200000",
  municipalityCode: "0730600000",
  barangayCode: "0730600003",
  street1: "Gorordo Ave",
  postalCode: "6000",
  latitude: 10.33,
  longitude: 123.9,
  salesOrgCode: "1000",
  salesOfficeCode: "100",
  distributionChannelCode: "41",
  customerGroup1Code: "RSF",
  customerGroup2Code: "RSS",
  customerGroupCode: "74",
  typeOfBusiness: "Sole Proprietor",
  paymentTermsCode: "ZC03",
  pricingProcedureCode: "2",
  deliveringPlantCode: "1000",
  shipTos: [
    {
      shipToParty: "Aling Nena",
      shipToAddress: "Same",
      contactPerson: "Nena",
      mobileNo: "+639171234567",
    },
  ],
  ...over,
});
/** @param {any} r */
const codes = (r) =>
  r.errors.map((/** @type {any} */ e) => `${e.field}:${e.code}`).sort();

describe("client field list", () => {
  test("51 fields in the sheet's order, with optional Street 1 (SP-0255)", () => {
    expect(FIELDS.map((f) => [f.section, f.label, f.required])).toEqual(
      json.fields.map((/** @type {any} */ f) => [
        f.section,
        f.field,
        // SP-0255 restores optional Street 1; SP-0220 dropped the separate Customer Address.
        ["Street 1", "Customer Address", "Postal Code"].includes(f.field)
          ? false
          : f.required,
      ]),
    );
    expect([...SECTIONS]).toEqual([
      ...new Set(json.fields.map((/** @type {any} */ f) => f.section)),
    ]);
  });
  test("SP-0220 Customer Address is hidden and built from the location", () => {
    const f = FIELDS.find((x) => x.key === "customerAddress");
    expect(f?.hidden).toBe(true);
    expect(f?.required).toBe(false);
  });
  test("dropdown shows Description (Code)", () => {
    expect(optionLabel({ code: "30", name: "General Trade" })).toBe(
      "General Trade (30)",
    );
    expect(optionLabel({ code: "0003", name: "Due in 7 days" })).toBe(
      "Due in 7 days (0003)",
    );
    expect(optionLabel({ code: "Corporation", name: "Corporation" })).toBe(
      "Corporation",
    );
  });
});

describe("dependent lists per sales organization (rule 8)", () => {
  test("ARI (2000) only has channels 20, 70, 80", () => {
    expect(
      index
        .options("distribution_channel", { salesOrgCode: "2000" })
        .map((r) => r.code),
    ).toEqual(["20", "70", "80"]);
    expect(
      index
        .options("distribution_channel", { salesOrgCode: "1000" })
        .map((r) => r.code),
    ).toEqual(["10", "20", "30", "40", "41", "50", "70", "80"]);
  });
  test("channel 30 for ARI is refused", () => {
    const r = validateCustomer(
      complete({
        salesOrgCode: "2000",
        salesOfficeCode: "130",
        deliveringPlantCode: "2000",
        distributionChannelCode: "30",
        customerGroup1Code: "KAS3",
        customerGroup2Code: "GGS",
      }),
      { lists, geography: cebu },
    );
    expect(codes(r)).toContain("distributionChannelCode:not_for_sales_org");
  });
  test("sales office and plant must belong to the sales org", () => {
    const r = validateCustomer(
      complete({ salesOfficeCode: "130", deliveringPlantCode: "2000" }),
      { lists, geography: cebu },
    );
    expect(codes(r)).toEqual([
      "deliveringPlantCode:not_for_sales_org",
      "salesOfficeCode:not_for_sales_org",
    ]);
  });
  test("group 1 must be under the channel and group 2 under group 1", () => {
    const r = validateCustomer(
      complete({ customerGroup1Code: "KAS3", customerGroup2Code: "GGS" }),
      { lists, geography: cebu },
    );
    expect(codes(r)).toEqual([
      "customerGroup1Code:not_for_channel",
      "customerGroup2Code:not_for_group1",
    ]);
    const r2 = validateCustomer(complete({ customerGroup2Code: "GGS" }), {
      lists,
      geography: cebu,
    });
    expect(codes(r2)).toEqual(["customerGroup2Code:not_for_group1"]);
  });
  test("unknown codes are invalid_option", () => {
    const r = validateCustomer(
      complete({ paymentTermsCode: "9999", customerGroupCode: "999" }),
      { lists, geography: cebu },
    );
    expect(codes(r)).toEqual([
      "customerGroupCode:invalid_option",
      "paymentTermsCode:invalid_option",
    ]);
  });
});

describe("SP-0255 optional Street 1", () => {
  for (const level of /** @type {const} */ (["draft", "field", "complete"])) {
    test(`${level} accepts omitted, null, empty and whitespace Street 1`, () => {
      for (const street1 of [undefined, null, "", " \t "]) {
        const r = validateCustomer(complete({ street1 }), {
          level,
          lists,
          geography: cebu,
        });
        expect(r.ok).toBe(true);
        expect(r.errors).toEqual([]);
        expect(r.value.street1).toBeNull();
        expect(r.value.latitude).toBe(10.33);
        expect(r.value.longitude).toBe(123.9);
      }
      const r = validateCustomer(complete({ street1: "  Gorordo Ave  " }), {
        level,
        lists,
        geography: cebu,
      });
      expect(r.errors).toEqual([]);
      expect(r.value.street1).toBe("Gorordo Ave");
      for (const key of ["houseNo", "street2", "floor", "roomStallNo"])
        expect(r.value[key]).toBeNull();
      const long = validateCustomer(complete({ street1: "x".repeat(201) }), {
        level,
        lists,
        geography: cebu,
      });
      expect(codes(long)).toEqual(["street1:too_long"]);
    });
  }
  test("field and complete still require valid coordinates without Street 1", () => {
    for (const level of /** @type {const} */ (["field", "complete"])) {
      for (const [latitude, longitude, code] of [
        [null, null, "required"],
        [91, 123.9, "invalid_coordinates"],
      ]) {
        const r = validateCustomer(
          complete({ street1: null, latitude, longitude }),
          {
            level,
            lists,
            geography: cebu,
          },
        );
        expect(codes(r)).toEqual([`coordinates:${code}`]);
      }
    }
  });
});

describe("SP-0220 normal address punctuation", () => {
  for (const level of /** @type {const} */ (["field", "complete"])) {
    test(`${level} preserves punctuation in customer, street and delivery addresses`, () => {
      for (const address of [
        "Blk 5, Lot 3. Brgy. Guadalupe",
        "#5-A / Lot 3. Brgy. Guadalupe, Cebu",
      ]) {
        const input = complete({
          customerAddress: address,
          street1: address,
          street2: address,
        });
        input.shipTos[0].shipToAddress = address;
        const result = validateCustomer(input, {
          level,
          lists,
          geography: cebu,
        });
        expect(result.errors).toEqual([]);
        expect(result.value).toMatchObject({
          customerAddress: address,
          street1: address,
          street2: address,
        });
        expect(result.value.shipTos[0].shipToAddress).toBe(address);
      }
    });
  }
});

describe("conditional required fields (rules 5, 6)", () => {
  test("a complete record passes", () => {
    const r = validateCustomer(complete(), { lists, geography: cebu });
    expect(r.errors).toEqual([]);
    expect(r.value.shipTos[0].mobileNo).toBe("09171234567");
  });
  test("Food Service (20) needs Grp 1 but no Grp 2", () => {
    const ok = validateCustomer(
      complete({
        distributionChannelCode: "20",
        customerGroup1Code: "FRT",
        customerGroup2Code: null,
      }),
      { lists, geography: cebu },
    );
    expect(ok.errors).toEqual([]);
    const extra = validateCustomer(
      complete({
        distributionChannelCode: "20",
        customerGroup1Code: "FRT",
        customerGroup2Code: "RSS",
      }),
      { lists, geography: cebu },
    );
    expect(codes(extra)).toEqual(["customerGroup2Code:not_applicable"]);
    const missing = validateCustomer(
      complete({
        distributionChannelCode: "20",
        customerGroup1Code: null,
        customerGroup2Code: null,
      }),
      { lists, geography: cebu },
    );
    expect(codes(missing)).toEqual(["customerGroup1Code:required"]);
  });
  test("Services (50) needs neither group", () => {
    const r = validateCustomer(
      complete({
        distributionChannelCode: "50",
        customerGroup1Code: null,
        customerGroup2Code: null,
      }),
      { lists, geography: cebu },
    );
    expect(r.errors).toEqual([]);
  });
  test("Grp 2 required when Grp 1 has values", () => {
    const r = validateCustomer(complete({ customerGroup2Code: "" }), {
      lists,
      geography: cebu,
    });
    expect(codes(r)).toEqual(["customerGroup2Code:required"]);
    expect(r.errors[0]).toMatchObject({
      label: "Customer Grp 2",
      section: "Customer Assignment",
      message: "Customer Grp 2 is required.",
    });
  });
  test("ADP block required only for Distributive Trade (40)", () => {
    const r = validateCustomer(
      complete({
        distributionChannelCode: "40",
        customerGroup1Code: "ADP",
        customerGroup2Code: "DSS",
      }),
      { lists, geography: cebu },
    );
    expect(r.errors.map((e) => e.label)).toEqual([
      "Distributor Code",
      "Distributor Name",
      "Distributor Customer Code",
      "Distribution Mode",
      "Sub-Distributor Code",
      "Sub-Distributor Name",
      "Distributor Salesman",
      "Distributor Salesman Code",
      "Truck Serving",
      "Truck Code",
      "Distributor Hub",
      "Cluster #",
      "Cluster Name",
    ]);
    expect(
      validateCustomer(complete(), { lists, geography: cebu }).errors,
    ).toEqual([]);
  });
  test("draft needs only Customer Name but still checks what is filled", () => {
    expect(
      validateCustomer({ customerName: "X" }, { level: "draft", lists }).errors,
    ).toEqual([]);
    const r = validateCustomer(
      { customerName: "", mobileNo: "1234", distributionChannelCode: "41" },
      { level: "draft", lists },
    );
    expect(codes(r)).toEqual([
      "customerName:required",
      "distributionChannelCode:choose_parent_first",
      "mobileNo:invalid_mobile",
    ]);
  });
  test("complete needs coordinates and a ship-to", () => {
    const r = validateCustomer(
      complete({ latitude: null, longitude: null, shipTos: [] }),
      { lists, geography: cebu },
    );
    expect(codes(r)).toEqual([
      "coordinates:required",
      "shipToParty:ship_to_required",
    ]);
  });
  test("ship-to entries are each validated", () => {
    const r = validateCustomer(
      complete({
        shipTos: [
          complete().shipTos[0],
          { shipToParty: "B", mobileNo: "0917" },
        ],
      }),
      { lists, geography: cebu },
    );
    expect(codes(r)).toEqual([
      "shipTos[1].contactPerson:required",
      "shipTos[1].mobileNo:invalid_mobile",
      "shipTos[1].shipToAddress:required",
    ]);
  });
});

describe("formats (rule 10)", () => {
  test("TIN", () => {
    expect(normalizeTin("123456789")).toBe("123-456-789");
    expect(normalizeTin("123-456-789-000")).toBe("123-456-789-000");
    expect(normalizeTin("123456789000")).toBe("123-456-789-000");
    expect(normalizeTin("12-3456789")).toBeNull();
    expect(normalizeTin("1234567")).toBeNull();
    expect(
      codes(
        validateCustomer(complete({ tin: "12345" }), {
          lists,
          geography: cebu,
        }),
      ),
    ).toEqual(["tin:invalid_tin"]);
  });
  test("PH mobile", () => {
    expect(normalizePhMobile("0917 123 4567")).toBe("09171234567");
    expect(normalizePhMobile("+639171234567")).toBe("09171234567");
    expect(normalizePhMobile("639171234567")).toBeNull();
    expect(normalizePhMobile("08171234567")).toBeNull();
  });
  test("email, coordinates, credit limit", () => {
    const r = validateCustomer(
      complete({ email: "nope", latitude: 95, creditLimit: -1 }),
      { lists, geography: cebu },
    );
    expect(codes(r)).toEqual([
      "coordinates:invalid_coordinates",
      "creditLimit:invalid_credit_limit",
      "email:invalid_email",
    ]);
    expect(
      validateCustomer(
        complete({ creditLimit: "15,000.50", email: "A@B.PH" }),
        { lists, geography: cebu },
      ).value,
    ).toMatchObject({ creditLimit: 15000.5, email: "a@b.ph" });
  });
});

describe("geography (rule 9)", () => {
  test("SP-0246 postal code is optional at every level, with or without a town list", () => {
    for (const level of /** @type {const} */ (["draft", "field", "complete"])) {
      for (const postalCodes of [[], ["6000"]]) {
        for (const postalCode of [
          undefined,
          null,
          "",
          " \t ",
          "9999",
          "0123",
        ]) {
          const r = validateCustomer(complete({ postalCode }), {
            level,
            lists,
            geography: { ...cebu, postalCodes },
          });
          expect(r.errors).toEqual([]);
          expect(r.value.postalCode).toBe(postalCode?.trim() || null);
        }
      }
    }
  });
  test("SP-0246 manual ZIPs still need exactly four ASCII digits", () => {
    for (const postalCode of ["123", "12345", "6a00", "１２３４"]) {
      const r = validateCustomer(complete({ postalCode }), {
        lists,
        geography: cebu,
      });
      expect(codes(r)).toEqual(["postalCode:invalid_option"]);
      expect(r.errors[0].message).toBe("Postal Code must be 4 digits.");
    }
  });
  test("each level must sit under its parent", () => {
    const r = validateCustomer(complete(), {
      lists,
      geography: {
        ...cebu,
        barangay: {
          code: "0731300003",
          name: "Banilad",
          municipalityCode: "0731300000",
        },
        province: { code: "0702200000", regionCode: "0600000000" },
      },
    });
    expect(codes(r)).toEqual([
      "barangayCode:geography_mismatch",
      "provinceCode:geography_mismatch",
    ]);
    const missing = validateCustomer(complete(), {
      lists,
      geography: { ...cebu, municipality: null },
    });
    expect(codes(missing)).toEqual(["municipalityCode:invalid_option"]);
  });
});

test("one-line address and same-as-customer ship-to", () => {
  expect(
    formatAddress({
      roomStallNo: "Stall 4",
      houseNo: "12",
      street1: "Gorordo Ave",
      barangayName: "Apas",
      municipalityName: "City of Cebu",
      provinceName: "Cebu",
      postalCode: "6000",
    }),
  ).toBe("Stall 4, 12 Gorordo Ave, Apas, City of Cebu, Cebu 6000");
  expect(formatAddress({})).toBeNull();
  expect(
    shipToFromCustomer(
      { customerName: "A", customerAddress: "B", mobileNo: "09171234567" },
      "Owner",
    ),
  ).toEqual({
    sameAsCustomer: true,
    shipToParty: "A",
    shipToAddress: "B",
    contactPerson: "Owner",
    mobileNo: "09171234567",
    email: null,
  });
});
