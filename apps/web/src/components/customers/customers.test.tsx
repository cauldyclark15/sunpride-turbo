import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { CustomerForm, type GeoLists } from "./customer-form";
import { CustomerListView } from "./customer-list";
import { CustomerEditorView } from "./customer-editor";
import {
  ADP_KEYS,
  addShipTo,
  checkDraft,
  emptyDraft,
  fieldErrorsFrom,
  generatedAddress,
  indexReference,
  removeShipTo,
  requiredMarks,
  setField,
  setShipTo,
  toPayload,
  type Customer,
  type CustomerRow,
  type Draft,
  type RefOption,
} from "./model";
import { OWNER_PAGES } from "../../config/navigation";
import { STORE_TABS } from "../cockpit/pages/stores-list";

/** A small slice of Sunpride's lists (real codes from the client's workbook). */
const ref = (
  list: string,
  code: string,
  name: string,
  parent: Partial<RefOption> = {},
): RefOption => ({ list, code, name, active: true, ...parent });
const LISTS: RefOption[] = [
  ref("sales_organization", "1000", "SFI"),
  ref("sales_organization", "2000", "ARI"),
  ref("sales_office", "100", "SFI Cebu", { salesOrgCode: "1000" }),
  ref("sales_office", "200", "ARI Cebu", { salesOrgCode: "2000" }),
  ref("distribution_channel", "10", "Key Accounts", { salesOrgCode: "1000" }),
  ref("distribution_channel", "30", "General Trade", { salesOrgCode: "1000" }),
  ref("distribution_channel", "40", "Distributive Trade", {
    salesOrgCode: "1000",
  }),
  ref("distribution_channel", "50", "Services", { salesOrgCode: "1000" }),
  ref("distribution_channel", "20", "Food Service", { salesOrgCode: "2000" }),
  ref("delivering_plant", "1000", "Cebu Production", { salesOrgCode: "1000" }),
  ref("delivering_plant", "2000", "ARI Plant", { salesOrgCode: "2000" }),
  ref("customer_group_1", "KAS", "Supermarket", {
    salesOrgCode: "1000",
    channelCode: "10",
  }),
  ref("customer_group_1", "GTS", "Sari-sari", {
    salesOrgCode: "1000",
    channelCode: "30",
  }),
  ref("customer_group_1", "DTD", "Distributor", {
    salesOrgCode: "1000",
    channelCode: "40",
  }),
  ref("customer_group_1", "FSR", "Restaurant", {
    salesOrgCode: "2000",
    channelCode: "20",
  }),
  ref("customer_group_2", "SMK", "Supermarket Chain", {
    salesOrgCode: "1000",
    channelCode: "10",
    group1Code: "KAS",
  }),
  ref("customer_group_2", "SSS", "Sari-Sari Store", {
    salesOrgCode: "1000",
    channelCode: "30",
    group1Code: "GTS",
  }),
  ref("customer_group_2", "DTS", "Sub-distributor", {
    salesOrgCode: "1000",
    channelCode: "40",
    group1Code: "DTD",
  }),
  ref("customer_group", "74", "NO GROUP"),
  ref("tax_classification", "1", "Liable for Taxes"),
  ref("type_of_business", "Sole Proprietor", "Sole Proprietor"),
  ref("payment_terms", "0003", "Due in 7 days"),
  ref("pricing_procedure", "2", "Standard Inclusive Tax"),
  ref("country", "PH", "Philippines"),
];
const index = indexReference(LISTS);
const GEO: GeoLists = {
  regions: [{ code: "0700000000", name: "Region VII (Central Visayas)" }],
  provinces: [{ code: "0702200000", name: "Cebu" }],
  municipalities: [{ code: "0730600000", name: "City of Cebu" }],
  barangays: [{ code: "0730600003", name: "Apas" }],
  postalCodes: [{ code: "6000", name: "Cebu City" }],
};

const fill = (d: Draft, pairs: [string, string, string?][]) =>
  pairs.reduce((acc, [k, v, n]) => setField(acc, k, v, n), d);

/** Everything the sheet requires, for channel 30 (General Trade). */
function completeDraft(): Draft {
  let d = fill(emptyDraft(), [
    ["registeredName", "Rosa Dela Cruz"],
    ["customerName", "Aling Rosa Store"],
    ["mobileNo", "09171234567"],
    ["taxClassificationCode", "1"],
    ["regionCode", "0700000000", "Region VII (Central Visayas)"],
    ["provinceCode", "0702200000", "Cebu"],
    ["municipalityCode", "0730600000", "City of Cebu"],
    ["barangayCode", "0730600003", "Apas"],
    ["houseNo", "12"],
    ["street1", "Gorordo Ave"],
    ["postalCode", "6000"],
    ["salesOrgCode", "1000"],
    ["salesOfficeCode", "100"],
    ["distributionChannelCode", "30"],
    ["customerGroup1Code", "GTS"],
    ["customerGroup2Code", "SSS"],
    ["customerGroupCode", "74"],
    ["typeOfBusiness", "Sole Proprietor"],
    ["paymentTermsCode", "0003"],
    ["pricingProcedureCode", "2"],
    ["deliveringPlantCode", "1000"],
  ]);
  d = { ...d, latitude: "10.3312", longitude: "123.9056" };
  return setShipTo(d, 0, "contactPerson", "Rosa");
}

const form = (
  d: Draft,
  extra: Partial<Parameters<typeof CustomerForm>[0]> = {},
) =>
  renderToStaticMarkup(
    <CustomerForm
      draft={d}
      onChange={() => undefined}
      index={index}
      geo={GEO}
      {...extra}
    />,
  );

describe("Customers label (customer = store)", () => {
  it("the owner nav, the tab and the list say Customers, never Stores", () => {
    const page = OWNER_PAGES.find((p) => p.id === "stores")!;
    expect(page.label).toBe("Customers");
    expect(page.href).toBe("/customers");
    expect(STORE_TABS[0].label).toBe("Customers");
    expect(STORE_TABS[1].label).toBe("New customers");
    const row: CustomerRow = {
      id: "o1",
      code: "SP000123",
      customerName: "Aling Rosa Store",
      registeredName: "Rosa Dela Cruz",
      customerAddress: null,
      status: "prospect",
      enrolmentStatus: "provisional",
      completeness: "draft",
      salesOrgCode: "1000",
      salesOfficeCode: "100",
      distributionChannelCode: "30",
      distributionChannelName: "General Trade",
      customerGroup1Code: null,
      customerGroup1Name: null,
      customerGroup2Code: null,
      customerGroup2Name: null,
      customerGroupCode: "74",
      customerGroupName: "NO GROUP",
      municipalityName: "City of Cebu",
      barangayName: "Apas",
      territoryName: null,
    };
    const html = renderToStaticMarkup(
      <CustomerListView
        index={index}
        rows={[row]}
        total={1}
        page={1}
        q=""
        status={null}
        filters={{ salesOrgCode: "1000" }}
        canAdd
        onSearch={() => undefined}
        onPage={() => undefined}
        onAdd={() => undefined}
        onStatus={() => undefined}
        onFilter={() => undefined}
        onEdit={() => undefined}
        customerHref={(r) => `/customers/customer?storeId=${r.id}`}
      />,
    );
    for (const h of [
      "Customer Code",
      "Customer Name",
      "Registered Name",
      "Distribution Channel",
      "Customer Group",
      "Sales Office",
      "Municipality",
      "Status",
    ])
      expect(html).toContain(h);
    expect(html).toContain("General Trade (30)");
    expect(html).toContain("SFI Cebu (100)");
    expect(html).toContain("Prospect");
    expect(html).toContain('href="/customers/customer?storeId=o1"');
    expect(html).toContain(">Complete<");
    expect(html).not.toMatch(/>Stores?</);
    // Filters: Sales Office narrowed to the chosen Sales Organization.
    expect(html).toContain("SFI Cebu (100)");
    expect(html).not.toContain("ARI Cebu (200)");
  });
});

describe("customer form follows the client's sheet", () => {
  it("shows the six sections in order with the client's labels", () => {
    const html = form(fill(emptyDraft(), [["distributionChannelCode", ""]]));
    const order = [
      "Customer General Information",
      "Customer Location",
      "Customer Assignment",
      "Payment Arrangement",
      "Delivery Arrangement",
    ].map((s) => html.indexOf(`data-section="${s}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const label of [
      "Registered Name",
      "TIN number",
      "Tax Classification",
      "Room No. / Stall No.",
      "Geographical Coordinates",
      "Customer Grp 1",
      "Customer Grp 2",
      "Terms of payment",
      "Customer Pricing Procedure",
      "Delivering Plant",
      "Ship-to Party",
    ])
      expect(html).toContain(label);
    // Field order inside a section is the sheet's order.
    expect(html.indexOf("Registered Name")).toBeLessThan(
      html.indexOf("Trade Name"),
    );
    expect(html.indexOf("Terms of payment")).toBeLessThan(
      html.indexOf("Credit Limit"),
    );
  });

  it("dropdowns show Description (Code) and wait for their parent", () => {
    const none = form(emptyDraft());
    expect(none).toContain("Choose Sales Organization first");
    const html = form(fill(emptyDraft(), [["salesOrgCode", "1000"]]));
    expect(html).toContain("General Trade (30)");
    expect(html).toContain("SFI Cebu (100)");
    expect(html).not.toContain("ARI Cebu (200)");
    expect(html).toContain("Due in 7 days (0003)");
    expect(html).toContain("Choose Distribution Channel first");
  });

  it("only channel 40 shows the ADP Specific block", () => {
    const dt = form(
      fill(emptyDraft(), [
        ["salesOrgCode", "1000"],
        ["distributionChannelCode", "40"],
      ]),
    );
    expect(dt).toContain('data-section="ADP Specific"');
    expect(dt).toContain("Distributor Salesman Code");
    const gt = form(
      fill(emptyDraft(), [
        ["salesOrgCode", "1000"],
        ["distributionChannelCode", "30"],
      ]),
    );
    expect(gt).not.toContain("ADP Specific");
    expect(gt).not.toContain("Distributor Code");
  });

  it("disables Customer Grp 1/2 when the chain has none", () => {
    const services = form(
      fill(emptyDraft(), [
        ["salesOrgCode", "1000"],
        ["distributionChannelCode", "50"],
      ]),
    );
    expect(services).toContain("None for this channel");
    const food = form(
      fill(emptyDraft(), [
        ["salesOrgCode", "2000"],
        ["distributionChannelCode", "20"],
        ["customerGroup1Code", "FSR"],
      ]),
    );
    expect(food).toContain("None for this group");
  });
});

describe("dependent dropdowns reset what was chosen under them", () => {
  it("Sales Organization clears office, channel, plant and both groups", () => {
    const d = completeDraft();
    const next = setField(d, "salesOrgCode", "2000");
    for (const k of [
      "salesOfficeCode",
      "distributionChannelCode",
      "deliveringPlantCode",
      "customerGroup1Code",
      "customerGroup2Code",
    ])
      expect(next.values[k], k).toBe("");
    expect(next.values.customerGroupCode).toBe("74");
    expect(next.values.paymentTermsCode).toBe("0003");
  });

  it("Distribution Channel clears the groups; Grp 1 clears Grp 2", () => {
    const d = completeDraft();
    const ch = setField(d, "distributionChannelCode", "10");
    expect(ch.values.customerGroup1Code).toBe("");
    expect(ch.values.customerGroup2Code).toBe("");
    const g1 = setField(d, "customerGroup1Code", "GTS");
    expect(g1.values.customerGroup2Code).toBe("SSS"); // same value: nothing cleared
  });

  it("Region clears Province → Barangay → Postal Code and the address follows", () => {
    const d = completeDraft();
    expect(generatedAddress(d)).toBe(
      "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
    );
    expect(d.values.customerAddress).toBe(
      "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
    );
    const next = setField(d, "regionCode", "0100000000", "Region I");
    for (const k of [
      "provinceCode",
      "municipalityCode",
      "barangayCode",
      "postalCode",
    ])
      expect(next.values[k], k).toBe("");
    expect(next.values.customerAddress).toBe("12 Gorordo Ave");
  });

  it("a typed Customer Address is kept; clearing it builds it again", () => {
    const typed = setField(
      completeDraft(),
      "customerAddress",
      "Near the chapel",
    );
    expect(typed.addressCustom).toBe(true);
    const moved = setField(typed, "street1", "Banilad Rd");
    expect(moved.values.customerAddress).toBe("Near the chapel");
    const back = setField(moved, "customerAddress", "");
    expect(back.addressCustom).toBe(false);
    expect(back.values.customerAddress).toContain("Banilad Rd");
    expect(toPayload(back).customerAddress).toBe("");
    expect(toPayload(typed).customerAddress).toBe("Near the chapel");
  });

  it("leaving channel 40 clears the ADP block", () => {
    let d = fill(emptyDraft(), [
      ["salesOrgCode", "1000"],
      ["distributionChannelCode", "40"],
      ["distributorCode", "D001"],
    ]);
    expect(d.values.distributorCode).toBe("D001");
    d = setField(d, "distributionChannelCode", "30");
    for (const k of ADP_KEYS) expect(d.values[k]).toBe("");
    expect(toPayload(d, { adp: false })).not.toHaveProperty("distributorCode");
  });
});

describe("conditional required (SPEC rules 5/6)", () => {
  it("marks follow the chain", () => {
    const base = fill(emptyDraft(), [["salesOrgCode", "1000"]]);
    const gt = requiredMarks(
      index,
      setField(base, "distributionChannelCode", "30"),
    );
    expect(gt.customerGroup1Code).toBe(true);
    expect(gt.customerGroup2Code).toBe(true);
    expect(gt.distributorCode).toBe(false);
    const sv = requiredMarks(
      index,
      setField(base, "distributionChannelCode", "50"),
    );
    expect(sv.customerGroup1Code).toBe(false);
    expect(sv.customerGroup2Code).toBe(false);
    const dt = requiredMarks(
      index,
      setField(base, "distributionChannelCode", "40"),
    );
    for (const k of ADP_KEYS) expect(dt[k], k).toBe(true);
    const fs = requiredMarks(
      index,
      fill(emptyDraft(), [
        ["salesOrgCode", "2000"],
        ["distributionChannelCode", "20"],
        ["customerGroup1Code", "FSR"],
      ]),
    );
    expect(fs.customerGroup1Code).toBe(true);
    expect(fs.customerGroup2Code).toBe(false);
    // Optional sheet fields never carry a marker.
    expect(gt.tradeName).toBe(false);
    expect(gt.creditLimit).toBe(false);
  });

  it("the browser check asks for Grp 2 only where the chain has it", () => {
    const d = completeDraft();
    expect(checkDraft(index, d, "complete")).toEqual({});
    const noG2 = setField(d, "customerGroup2Code", "");
    expect(checkDraft(index, noG2, "complete")).toEqual({
      customerGroup2Code: "Customer Grp 2 is required.",
    });
    const services = fill(d, [["distributionChannelCode", "50"]]);
    const errs = checkDraft(index, services, "complete");
    expect(errs.customerGroup1Code).toBeUndefined();
    expect(errs.customerGroup2Code).toBeUndefined();
    const dt = fill(d, [
      ["distributionChannelCode", "40"],
      ["customerGroup1Code", "DTD"],
      ["customerGroup2Code", "DTS"],
    ]);
    expect(checkDraft(index, dt, "complete").distributorCode).toBe(
      "Distributor Code is required.",
    );
    // A bad customer mobile is reported once, not again on the "same as customer" ship-to.
    const bad = checkDraft(index, setField(d, "mobileNo", "12345"), "draft");
    expect(Object.keys(bad)).toEqual(["mobileNo"]);
    // Drafts only need Customer Name.
    expect(
      checkDraft(index, fill(emptyDraft(), [["customerName", "X"]]), "draft"),
    ).toEqual({});
  });
});

describe("ship-to list", () => {
  it("adds and removes entries but keeps at least one", () => {
    const d = completeDraft();
    expect(d.shipTos).toHaveLength(1);
    expect(removeShipTo(d, 0).shipTos).toHaveLength(1);
    const two = addShipTo(d);
    expect(two.shipTos).toHaveLength(2);
    expect(two.shipTos[1]!.sameAsCustomer).toBe(false);
    const html = form(two);
    expect(html).toContain("Ship-to 2");
    expect(html).toContain('aria-label="Remove ship-to 2"');
    const one = removeShipTo(two, 0);
    expect(one.shipTos).toHaveLength(1);
    expect(one.shipTos[0]!.sameAsCustomer).toBe(false);
    expect(form(one)).not.toContain("Remove ship-to");
  });

  it("'same as customer' copies name, address, mobile and email", () => {
    const d = completeDraft();
    const [first] = toPayload(d).shipTos as Record<string, unknown>[];
    expect(first).toEqual({
      sameAsCustomer: true,
      shipToParty: "Aling Rosa Store",
      shipToAddress: "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
      contactPerson: "Rosa",
      mobileNo: "09171234567",
      email: null,
    });
    const own = setShipTo(
      setShipTo(d, 0, "sameAsCustomer", false),
      0,
      "shipToParty",
      "Warehouse",
    );
    expect(
      (toPayload(own).shipTos as Record<string, unknown>[])[0]!.shipToParty,
    ).toBe("Warehouse");
  });
});

describe("approval errors land next to the field", () => {
  const serverError = {
    code: "validation_failed",
    message: "Terms of payment is required.",
    details: {
      errors: [
        {
          code: "required",
          field: "paymentTermsCode",
          label: "Terms of payment",
          section: "Payment Arrangement",
          message: "Terms of payment is required.",
        },
        {
          code: "invalid_mobile",
          field: "shipTos[0].mobileNo",
          index: 0,
          label: "Mobile No.",
          section: "Delivery Arrangement",
          message:
            "Mobile No. must be a Philippine mobile number: 09XXXXXXXXX or +639XXXXXXXXX.",
        },
      ],
    },
  };

  it("maps details.errors by field", () => {
    const { fields, message } = fieldErrorsFrom(serverError);
    expect(fields).toEqual({
      paymentTermsCode: "Terms of payment is required.",
      "shipTos[0].mobileNo":
        "Mobile No. must be a Philippine mobile number: 09XXXXXXXXX or +639XXXXXXXXX.",
    });
    expect(message).toBe("2 fields need attention. Each one is marked below.");
    expect(fieldErrorsFrom({ message: "Not found." })).toEqual({
      fields: {},
      message: "Not found.",
    });
  });

  it("renders each message inside its field, and approve only for approvers", () => {
    const d = completeDraft();
    const { fields } = fieldErrorsFrom(serverError);
    const customer = {
      id: "o1",
      code: "SP000123",
      status: "prospect",
      completeness: "draft",
      shipTos: [],
    } as unknown as Customer;
    const view = (canApprove: boolean, canEdit = true) =>
      renderToStaticMarkup(
        <CustomerEditorView
          customer={customer}
          draft={d}
          onChange={() => undefined}
          index={index}
          geo={GEO}
          errors={fields}
          message={{ tone: "error", text: "2 fields need attention" }}
          readOnly={!canEdit}
          busy={false}
          canEdit={canEdit}
          canApprove={canApprove}
        />,
      );
    const html = view(true);
    const block = html.slice(
      html.indexOf('data-field="paymentTermsCode"'),
      html.indexOf('data-field="creditLimit"'),
    );
    expect(block).toContain('role="alert"');
    expect(block).toContain("Terms of payment is required.");
    expect(block).toContain('aria-invalid="true"');
    const ship = html.slice(html.indexOf('data-ship-to="0"'));
    expect(ship).toContain("must be a Philippine mobile number");
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Deactivate<");
    expect(view(false)).not.toContain(">Approve<");
    // Read-only role: no save/approve/deactivate, every input disabled.
    const ro = view(false, false);
    expect(ro).not.toContain(">Save<");
    expect(ro).not.toContain(">Deactivate<");
    expect(ro).toContain("Read only");
  });
});
