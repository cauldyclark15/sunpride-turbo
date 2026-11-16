import { type FocusEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerForm, type GeoLists } from "./customer-form";
import {
  FIELDS,
  addShipTo,
  emptyDraft,
  generatedAddress,
  indexReference,
  normalizeCustomerText,
  setField,
  setShipTo,
  toPayload,
  type Draft,
} from "./model";

// Capture the real form's handlers without replacing its field definitions or model.
const captured = vi.hoisted(() => new Map<string, Record<string, unknown>>());
function capture(type: unknown, props: Record<string, unknown>) {
  if (type === "input" && typeof props.id === "string")
    captured.set(props.id, props);
}
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const wrap =
    (fn: typeof actual.jsx) =>
    (type: React.ElementType, props: Record<string, unknown>, key: string) => {
      capture(type, props);
      return fn(type, props, key);
    };
  return { ...actual, jsx: wrap(actual.jsx), jsxs: wrap(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      capture(args[0], args[1] as Record<string, unknown>);
      return actual.jsxDEV(...args);
    },
  };
});

const index = indexReference([]);
const geo: GeoLists = {
  regions: [],
  provinces: [],
  municipalities: [],
  barangays: [],
  postalCodes: [],
};
function form(draft: Draft, onChange: (next: Draft) => void, readOnly = false) {
  captured.clear();
  return renderToStaticMarkup(
    <CustomerForm
      draft={draft}
      onChange={onChange}
      index={index}
      geo={geo}
      readOnly={readOnly}
    />,
  );
}
function blur(id: string, value: string) {
  const handler = captured.get(id)?.onBlur;
  expect(handler, id).toBeTypeOf("function");
  (handler as (event: FocusEvent<HTMLInputElement>) => void)({
    currentTarget: { value },
  } as FocusEvent<HTMLInputElement>);
}
beforeEach(() => captured.clear());

describe("SP-0182 customer text casing", () => {
  it.each([
    ["aling rosa store", "Aling Rosa Store"],
    ["ALING ROSA STORE", "Aling Rosa Store"],
    ["aLiNg rOsA sToRe", "Aling Rosa Store"],
    [
      "  PEÑA'S  SARI-SARI / o'NEIL d’ANGELO\nMUÑOZ",
      "  Peña's  Sari-Sari / O'Neil D’Angelo\nMuñoz",
    ],
    ["12B GORORDO AVE., CEBU", "12B Gorordo Ave., Cebu"],
    ["", ""],
  ])(
    "normalizes %j without losing punctuation or spacing",
    (input, expected) => {
      expect(normalizeCustomerText("customerName", input)).toBe(expected);
      expect(normalizeCustomerText("customerName", expected)).toBe(expected);
    },
  );

  it("normalizes every free-text field, including the ADP and ship-to blocks", () => {
    for (const field of FIELDS.filter((f) => f.kind === "text")) {
      const isIdentifier =
        field.key.endsWith("Code") || field.key === "clusterNo";
      expect(normalizeCustomerText(field.key, "mIXed TEXT"), field.key).toBe(
        isIdentifier ? "mIXed TEXT" : "Mixed Text",
      );
    }
  });

  it("leaves email, reference codes, identifiers, numbers and coordinates unchanged", () => {
    for (const [key, value] of [
      ["email", "Sales.Team+CEBU@Example.COM"],
      ["code", "SAP-abC001"],
      ["distributorCode", "dIST-aBC123"],
      ["distributorCustomerCode", "CUSt-001"],
      ["subDistributorCode", "sUB-A1"],
      ["distributorSalesmanCode", "SLs-001"],
      ["truckCode", "TRK-ab12"],
      ["clusterNo", "CL-a1"],
      ["customerGroup1Code", "GTS"],
      ["countryCode", "PH"],
      ["regionCode", "0700000000"],
      ["mobileNo", "+639171234567"],
      ["tin", "001-002-003"],
      ["creditLimit", "1,234.50"],
      ["latitude", "10.331200"],
    ])
      expect(normalizeCustomerText(key!, value!), key).toBe(value);
  });

  it("keeps typing untouched and updates the visible customer field on blur", () => {
    let draft = emptyDraft();
    const onChange = vi.fn((next: Draft) => {
      draft = next;
    });
    form(draft, onChange);
    const change = captured.get("cm-customerName")!.onChange as (e: {
      target: { value: string };
    }) => void;
    change({ target: { value: "aLiNg rOsA sToRe" } });
    expect(draft.values.customerName).toBe("aLiNg rOsA sToRe");
    form(draft, onChange);
    blur("cm-customerName", draft.values.customerName!);
    expect(draft.values.customerName).toBe("Aling Rosa Store");
    expect(form(draft, onChange)).toContain('value="Aling Rosa Store"');
    onChange.mockClear();
    blur("cm-customerName", "Aling Rosa Store");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("normalizes custom addresses and ship-to fields on blur but not either email", () => {
    let draft = setShipTo(emptyDraft(), 0, "sameAsCustomer", false);
    const onChange = (next: Draft) => {
      draft = next;
    };
    for (const [id, value] of [
      ["cm-customerAddress", "NEAR THE CHAPEL"],
      ["cm-shipTos-0--shipToParty", "SECOND WAREHOUSE"],
      ["cm-shipTos-0--shipToAddress", "12 MAIN STREET"],
      ["cm-shipTos-0--contactPerson", "JUAN DELA CRUZ"],
    ]) {
      form(draft, onChange);
      const change = captured.get(id!)!.onChange as (e: {
        target: { value: string };
      }) => void;
      change({ target: { value: value! } });
      form(draft, onChange);
      blur(id!, value!);
    }
    expect(draft.addressCustom).toBe(true);
    expect(draft.values.customerAddress).toBe("Near The Chapel");
    expect(draft.shipTos[0]).toMatchObject({
      shipToParty: "Second Warehouse",
      shipToAddress: "12 Main Street",
      contactPerson: "Juan Dela Cruz",
    });
    const email = "Sales.Team+CEBU@Example.COM";
    draft = setField(draft, "email", email);
    draft = setShipTo(draft, 0, "email", email);
    const unchanged = vi.fn();
    form(draft, unchanged);
    blur("cm-email", email);
    blur("cm-shipTos-0--email", email);
    expect(unchanged).not.toHaveBeenCalled();
    const payload = toPayload(draft);
    expect(payload.email).toBe(email);
    expect(payload.shipTos).toMatchObject([{ email }]);
  });

  it("normalizes the save payload even without blur, including separate and copied ship-tos", () => {
    let draft = addShipTo(emptyDraft());
    draft.code = "SAP-abC001";
    for (const f of FIELDS.filter((f) => f.kind === "text" && !f.shipTo))
      draft.values[f.key] = "mIXed TEXT";
    draft = setField(draft, "customerAddress", "NEAR THE CHAPEL");
    draft.values.email = "Mixed.Case@Example.COM";
    draft.shipTos[0]!.contactPerson = "ROSA DELA CRUZ";
    draft.shipTos[1] = {
      sameAsCustomer: false,
      shipToParty: "SECOND WAREHOUSE",
      shipToAddress: "12 MAIN STREET",
      contactPerson: "JUAN DELA CRUZ",
      mobileNo: "09171234567",
      email: "Other.Team@Example.COM",
    };
    const payload = toPayload(draft);
    for (const f of FIELDS.filter((f) => f.kind === "text" && !f.shipTo)) {
      const expected =
        f.key === "customerAddress"
          ? "Near The Chapel"
          : f.key.endsWith("Code") || f.key === "clusterNo"
            ? "mIXed TEXT"
            : "Mixed Text";
      expect(payload[f.key], f.key).toBe(expected);
    }
    expect(payload.email).toBe("Mixed.Case@Example.COM");
    expect(payload.shipTos).toEqual([
      {
        sameAsCustomer: true,
        shipToParty: "Mixed Text",
        shipToAddress: "Near The Chapel",
        contactPerson: "Rosa Dela Cruz",
        mobileNo: null,
        email: "Mixed.Case@Example.COM",
      },
      {
        sameAsCustomer: false,
        shipToParty: "Second Warehouse",
        shipToAddress: "12 Main Street",
        contactPerson: "Juan Dela Cruz",
        mobileNo: "09171234567",
        email: "Other.Team@Example.COM",
      },
    ]);
    // Serialization does not silently rewrite other stored/typed drafts or customer codes.
    expect(draft.values.registeredName).toBe("mIXed TEXT");
    expect(draft.code).toBe("SAP-abC001");
  });

  it("normalizes typed address parts while preserving official geography labels and generated mode", () => {
    let draft = setField(emptyDraft(), "street1", "GORORDO AVE");
    draft = setField(draft, "municipalityCode", "0730600000", "City of Cebu");
    expect(generatedAddress(draft)).toBe("Gorordo Ave, City of Cebu");
    expect(draft.values.customerAddress).toBe("Gorordo Ave, City of Cebu");
    expect(draft.addressCustom).toBe(false);
    const onChange = vi.fn();
    form(draft, onChange);
    blur("cm-customerAddress", draft.values.customerAddress!);
    expect(onChange).not.toHaveBeenCalled();
    const payload = toPayload(draft);
    expect(payload.street1).toBe("Gorordo Ave");
    expect(payload.customerAddress).toBe("");
    expect(payload.shipTos).toMatchObject([
      { shipToAddress: "Gorordo Ave, City of Cebu" },
    ]);
    expect(payload.municipalityCode).toBe("0730600000");
  });

  it("does not change read-only field access", () => {
    const onChange = vi.fn();
    const html = form(emptyDraft(), onChange, true);
    expect(captured.get("cm-customerName")!.disabled).toBe(true);
    expect(captured.get("cm-shipTos-0--contactPerson")!.disabled).toBe(true);
    expect(html).not.toContain("when you leave a field");
    expect(onChange).not.toHaveBeenCalled();
  });
});
