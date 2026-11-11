// SP-0170 customer template parity with Sunpride's own workbook, the .xlsx/.csv readers, the
// dropdown/PSGC resolution and the update rule — the shared code the web app and API both run.
import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { FIELDS } from "@sunpride/customer-master";
import {
  CLIENT_REMARKS,
  CUSTOMER_COLUMNS,
  CUSTOMER_HEADERS,
  EXAMPLE,
  LIST_FIRST_ROW,
  customerTemplateCsv,
  geoLookup,
  listSheets,
  mapHeader,
  parseCustomerCsv,
  parseCustomerFile,
  resolveOption,
  validateCustomerRows,
  writerInput,
} from "../src/customers.js";
import {
  buildCustomerTemplateWorkbook,
  cellText,
  customerTemplateXlsx,
} from "../src/customers-xlsx.js";
import { referenceIndex } from "@sunpride/customer-master";

const root = new URL("../../../", import.meta.url).pathname;
const CLIENT_XLSX = `${root}docs/requirements/client-customer-information-template-2026-11-10.xlsx`;
const CLIENT_JSON = `${root}packages/db/reference/sunpride-customer-master-2026-11-10.json`;

/** The client's workbook, opened once. */
const client = new ExcelJS.Workbook();
await client.xlsx.readFile(CLIENT_XLSX);
/** Flatten the client JSON exactly as packages/db does for customer_reference_values. */
const { referenceRows } = await import(
  `${root}packages/db/src/customer-reference.js`
);
const REFERENCE = referenceRows(JSON.parse(await Bun.file(CLIENT_JSON).text()));

/** @param {ExcelJS.Worksheet} ws @param {number} from */
function grid(ws, from = 1) {
  /** @type {string[][]} */ const out = [];
  ws.eachRow((row, n) => {
    if (n < from) return;
    const values = /** @type {any[]} */ (row.values);
    out.push(values.slice(1).map((v) => cellText(v).trim()));
  });
  return out;
}

describe("SP-0170 template = the client's Customer Information template", () => {
  test("Customer Code + every field of the 'source' tab, same order, labels, required flags and remarks", () => {
    const sections = new Set([
      "Customer General Information",
      "Customer Location",
      "Customer Assignment",
      "Payment Arrangement",
      "Delivery Arrangement",
      "ADP Specific",
    ]);
    /** @type {{label:string,required:boolean,remark:string}[]} */
    const sheet = [];
    for (const r of grid(
      /** @type {any} */ (client.getWorksheet("source")),
      2,
    )) {
      const [label, req, remark] = r;
      if (!label || sections.has(label)) continue;
      sheet.push({ label, required: req === "Y", remark: remark ?? "" });
    }
    expect(sheet.length).toBe(51);
    expect(CUSTOMER_HEADERS[0]).toBe("Customer Code");
    expect(
      CUSTOMER_COLUMNS.slice(1).map((c) => ({
        label: c.label,
        required: c.required,
        remark: c.remark,
      })),
    ).toEqual(sheet);
    expect(CLIENT_REMARKS.length).toBe(FIELDS.length);
  });
  test("first ship-to inline after Delivering Plant; ADP Specific block last", () => {
    const labels = [...CUSTOMER_HEADERS];
    const plant = labels.indexOf("Delivering Plant");
    expect(labels.slice(plant + 1, plant + 6)).toEqual([
      "Ship-to Party",
      "Ship-to Address",
      "Contact Person",
      "Mobile No.",
      "Email Address",
    ]);
    expect(CUSTOMER_COLUMNS.slice(-13).every((c) => c.when === "adp")).toBe(
      true,
    );
  });
  test("every list sheet equals the reference rows, with the client's tab names and headings", async () => {
    const sheets = listSheets(REFERENCE);
    const clientTabs = client.worksheets.map((w) => w.name).slice(1);
    expect(sheets.map((s) => s.name)).toEqual(clientTabs);
    /** @param {string} list */
    const codes = (list) =>
      REFERENCE.filter((/** @type {any} */ r) => r.list === list).map(
        (/** @type {any} */ r) => `${r.code}|${r.name}`,
      );
    /** @param {string} name */
    const sheet = (name) =>
      /** @type {import("../src/customers.js").ListSheet} */ (
        sheets.find((s) => s.name === name)
      );
    const pair = (/** @type {string} */ name, a = 0, b = 1) =>
      sheet(name).rows.map((r) => `${r[a]}|${r[b]}`);
    expect(pair("Sales Organization")).toEqual(codes("sales_organization"));
    expect(pair("Customer Groups")).toEqual(codes("customer_group"));
    expect(pair("Distribution Channel", 2, 3)).toEqual(
      codes("distribution_channel"),
    );
    expect(pair("Sales Office", 2, 3)).toEqual(codes("sales_office"));
    expect(pair("Delivering Plant", 2, 3)).toEqual(codes("delivering_plant"));
    expect(pair("Payment Terms")).toEqual(codes("payment_terms"));
    expect(pair("Tax Class")).toEqual(codes("tax_classification"));
    expect(pair("Pricing Procedure")).toEqual(codes("pricing_procedure"));
    expect(sheet("Type of Business").rows.map((r) => r[0])).toEqual(
      REFERENCE.filter(
        (/** @type {any} */ r) => r.list === "type_of_business",
      ).map((/** @type {any} */ r) => r.name),
    );
    expect(sheet("List of Agents").rows).toEqual([]);
    // Chain: every (org, channel, Grp1, Grp2) of the client's tab.
    const chain = sheet("Cust. Grp. 1&2").rows.filter((r) => r[2]);
    const json = JSON.parse(await Bun.file(CLIENT_JSON).text());
    expect(chain.length).toBe(
      json.customer_group_chain.filter((/** @type {any} */ c) => c.group1)
        .length,
    );
    expect(chain[0]?.slice(0, 4)).toEqual([
      "SFI (1000)",
      "Key Accounts (10)",
      "Key Accounts 1 (KAS1)",
      "Key Accts. National (KAN)",
    ]);
    // Same codes as the client's own tabs (codes are text: "0002", "ZC03").
    const terms = grid(
      /** @type {any} */ (client.getWorksheet("Payment Terms")),
      3,
    ).map((r) => r[0]);
    expect(sheet("Payment Terms").rows.map((r) => r[0])).toEqual(terms);
  });
  test("the .xlsx: Instructions, Customers (required marked, remarks as comments, dropdowns), list sheets", async () => {
    const bytes = await customerTemplateXlsx(REFERENCE);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(/** @type {any} */ (bytes));
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Instructions",
      "Customers",
      ...client.worksheets.map((w) => w.name).slice(1),
    ]);
    const ws = /** @type {ExcelJS.Worksheet} */ (wb.getWorksheet("Customers"));
    expect(grid(ws)[0]).toEqual([...CUSTOMER_HEADERS]);
    const reg = ws.getCell(1, 2);
    expect(reg.font?.bold).toBe(true);
    expect(JSON.stringify(reg.note)).toContain("Sunpride remark: manual input");
    expect(ws.getCell(1, 3).font?.bold).toBeFalsy(); // Trade Name optional
    const grp2 = ws.getCell(1, CUSTOMER_HEADERS.indexOf("Customer Grp 2") + 1);
    expect(JSON.stringify(grp2.note)).toContain(
      "Required when the chosen Customer Grp 1",
    );
    // Dropdowns point at the list sheets.
    const model = /** @type {any} */ (
      buildCustomerTemplateWorkbook(REFERENCE).getWorksheet("Customers")
    ).dataValidations.model;
    const col = (/** @type {string} */ label) =>
      String.fromCharCode(65 + CUSTOMER_HEADERS.indexOf(label));
    expect(
      model[`${col("Tax Classification")}2:${col("Tax Classification")}5001`]
        .formulae[0],
    ).toBe(`'Tax Class'!$C$${LIST_FIRST_ROW}:$C$${LIST_FIRST_ROW + 4}`);
    // 12 list columns; Sales Partner has no dropdown while "List of Agents" is empty.
    expect(Object.keys(model).length).toBe(12);
    const tab = /** @type {ExcelJS.Worksheet} */ (
      wb.getWorksheet("Payment Terms")
    );
    expect(tab.getCell(LIST_FIRST_ROW, 3).value).toBe(
      "Cash upon delivery (ZC03)",
    );
    // The template reads back as a valid empty template.
    const parsed = await parseCustomerFile("t.xlsx", bytes);
    expect(parsed.header).toEqual([...CUSTOMER_HEADERS]);
    expect(parsed.fileErrors.map((e) => e.code)).toEqual(["empty_file"]);
  });
});

describe("SP-0170 reading files", () => {
  test("CSV: BOM, quotes, CRLF; repeated labels map by occurrence; column order may differ", () => {
    const header = [...CUSTOMER_HEADERS];
    const { ids } = mapHeader(header);
    expect(ids.filter((x) => x === "mobileNo").length).toBe(1);
    expect(ids).toContain("shipTo.mobileNo");
    const reordered = [header[3], ...header.slice(0, 3), ...header.slice(4)];
    expect(mapHeader(/** @type {string[]} */ (reordered)).missing).toEqual([]);
    const line = CUSTOMER_COLUMNS.map((c) => {
      const v = EXAMPLE[c.id] ?? "";
      return /[",]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
    }).join(",");
    const parsed = parseCustomerCsv(`${customerTemplateCsv()}${line}\r\n\r\n`);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.values.customerAddress).toBe(
      "12 Gorordo Ave, Apas, City of Cebu, Cebu 6000",
    );
  });
  test("missing / unknown columns are listed", () => {
    const parsed = parseCustomerCsv(
      `${CUSTOMER_HEADERS.filter((h) => h !== "Region").join(",")},Area\r\n`,
    );
    expect(parsed.fileErrors[0]?.code).toBe("header_mismatch");
    expect(parsed.fileErrors[0]?.message).toContain("missing columns: Region");
    expect(parsed.fileErrors[0]?.message).toContain("unknown columns: Area");
    const noShip = parseCustomerCsv(
      `${CUSTOMER_HEADERS.slice(0, -15).join(",")}\r\n`,
    );
    expect(noShip.fileErrors[0]?.message).toContain(
      "Mobile No. (Delivery Arrangement)",
    );
  });
  test("xlsx: numbers that lost leading zeros, rich text and a renamed sheet still read", async () => {
    const wb = buildCustomerTemplateWorkbook(REFERENCE);
    const ws = /** @type {ExcelJS.Worksheet} */ (wb.getWorksheet("Customers"));
    CUSTOMER_COLUMNS.forEach((c, i) => {
      ws.getCell(2, i + 1).value = EXAMPLE[c.id] ?? null;
    });
    const at = (/** @type {string} */ id) =>
      CUSTOMER_COLUMNS.findIndex((c) => c.id === id) + 1;
    ws.getCell(2, at("mobileNo")).value = 9171234567;
    ws.getCell(2, at("paymentTermsCode")).value = 3; // "0003" typed as a number
    ws.getCell(2, at("registeredName")).value = {
      richText: [{ text: "Tindahan ni " }, { text: "Aling Rosa Inc." }],
    };
    ws.name = "My customers";
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const parsed = await parseCustomerFile("mine.xlsx", bytes);
    expect(parsed.fileErrors).toEqual([]);
    const { errors, items } = validateCustomerRows(parsed.rows, REFERENCE);
    expect(errors).toEqual([]);
    const c = /** @type {any} */ (items.get(2)).customer;
    expect(c.mobileNo).toBe("09171234567");
    expect(c.paymentTermsCode).toBe("0003");
    expect(c.registeredName).toBe("Tindahan ni Aling Rosa Inc.");
  });
  test("not an xlsx/csv, or a broken xlsx, is a clear file error", async () => {
    expect(
      (await parseCustomerFile("a.pdf", new Uint8Array())).fileErrors[0]?.code,
    ).toBe("unreadable_file");
    expect(
      (await parseCustomerFile("a.xlsx", new Uint8Array([1, 2, 3])))
        .fileErrors[0]?.code,
    ).toBe("unreadable_file");
  });
});

describe("SP-0170 values", () => {
  const index = referenceIndex(REFERENCE);
  test("dropdown cells accept 'Description (Code)', the code or the description", () => {
    const all = index.all("payment_terms");
    for (const t of ["Due in 7 days (0003)", "0003", "3", "due in 7 DAYS"])
      expect(resolveOption(t, all, all).code).toBe("0003");
    expect(resolveOption("Weekly", all, all).code).toBe("Weekly");
    // Dependent: the same description under another parent still resolves for the rules.
    const ari = index.options("distribution_channel", { salesOrgCode: "2000" });
    expect(
      resolveOption("General Trade", ari, index.all("distribution_channel"))
        .code,
    ).toBe("30");
  });
  test("PSGC names (case/accents/'City of') or codes", () => {
    const geo = geoLookup({
      regions: [{ code: "1300000000", name: "National Capital Region (NCR)" }],
      provinces: [
        {
          code: "1307500000",
          name: "NCR, Fourth District",
          regionCode: "1300000000",
        },
      ],
      municipalities: [
        {
          code: "1307501000",
          name: "City of Las Piñas",
          provinceCode: "1307500000",
          regionCode: "1300000000",
        },
      ],
      barangays: [
        {
          code: "1307501001",
          name: "Almanza Uno",
          municipalityCode: "1307501000",
        },
      ],
      postalCodes: new Map([["1307501000", ["1740"]]]),
    });
    const g = geo.resolve({
      regionCode: "ncr",
      provinceCode: "1307500000",
      municipalityCode: "las pinas city",
      barangayCode: "ALMANZA UNO",
    });
    expect(g.region?.code).toBe("1300000000");
    expect(g.municipality?.code).toBe("1307501000");
    expect(g.barangay?.code).toBe("1307501001");
    expect(g.postalCodes).toEqual(["1740"]);
    expect(geo.resolve({ regionCode: "307500000" }).region).toBeNull();
  });
  test("conditional required: Grp 1/2 by the chain, ADP only for channel 40", () => {
    /** @param {Record<string,string>} over */
    const check = (over) =>
      validateCustomerRows(
        [{ rowNumber: 2, values: { ...EXAMPLE, ...over } }],
        index,
      ).errors.map((e) => `${e.label}:${e.code}`);
    expect(check({ customerGroup1Code: "" })).toEqual([
      "Customer Grp 1:required",
      "Customer Grp 2:choose_parent_first",
    ]);
    expect(
      check({
        distributionChannelCode: "Food Service (20)",
        customerGroup1Code: "Restaurant (FRT)",
        customerGroup2Code: "",
      }),
    ).toEqual([]);
    expect(
      check({
        distributionChannelCode: "Food Service (20)",
        customerGroup1Code: "FRT",
      }),
    ).toEqual(["Customer Grp 2:not_applicable"]);
    expect(
      check({
        distributionChannelCode: "Services (50)",
        customerGroup1Code: "",
        customerGroup2Code: "",
      }),
    ).toEqual([]);
    const adp = check({
      distributionChannelCode: "40",
      customerGroup1Code: "ADP",
      customerGroup2Code: "DGS",
    });
    expect(adp.length).toBe(13);
    expect(adp.every((x) => x.endsWith(":required"))).toBe(true);
    expect(check({ salesOrgCode: "2000" })).toEqual(
      expect.arrayContaining([
        "Sales Office:not_for_sales_org",
        "Distribution Channel:not_for_sales_org",
        "Delivering Plant:not_for_sales_org",
      ]),
    );
  });
  test("updates send only filled cells; the first ship-to keeps blank cells, others stay", () => {
    const row = {
      rowNumber: 2,
      values: {
        ...EXAMPLE,
        tradeName: "",
        creditLimit: "",
        "shipTo.email": "",
      },
    };
    const { items } = validateCustomerRows([row], index);
    const item = /** @type {any} */ (items.get(2));
    const input = writerInput(item, row, index, {
      shipTos: [
        { shipToParty: "Old", email: "old@x.ph", contactPerson: "Old" },
        { shipToParty: "Second", email: "s@x.ph" },
      ],
    });
    expect("tradeName" in input).toBe(false);
    expect("creditLimit" in input).toBe(false);
    expect(input.customerName).toBe("Aling Rosa Store");
    expect(input.shipTos[0]).toMatchObject({
      shipToParty: "Aling Rosa Store",
      email: "old@x.ph",
      contactPerson: "Rosa Dela Cruz",
    });
    expect(input.shipTos[1]).toMatchObject({ shipToParty: "Second" });
    expect(writerInput(item, row, index, null).tradeName).toBeNull();
  });
});
