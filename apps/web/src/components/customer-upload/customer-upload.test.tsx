import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_COLUMNS,
  EXAMPLE,
  customerTemplateCsv,
  parseCustomerFile,
} from "@sunpride/import-templates/customers";
import { buildCustomerTemplateWorkbook } from "@sunpride/import-templates/customers-xlsx";
import type { ReferenceRow } from "@sunpride/customer-master";
import {
  CUSTOMER_HEADERS,
  columnLabel,
  errorIndex,
  errorsCsv,
  mergePreviews,
  reportCsv,
  syncValidate,
  type RunRow,
  type RunSummary,
} from "../../lib/customer-upload";

const downloads = vi.hoisted(() => [] as { name: string; content: string }[]);
vi.mock("../../lib/import-csv-export", async (original) => ({
  ...(await original<typeof import("../../lib/import-csv-export")>()),
  downloadCsv: (name: string, content: string) =>
    downloads.push({ name, content }),
}));
vi.mock("../../lib/api", () => ({
  apiFetch: vi.fn(),
  useApi: () => ({
    data: {
      rows: [
        {
          id: "run-1",
          fileName: "north.xlsx",
          status: "interrupted",
          rowCount: 250,
          succeeded: 100,
          failed: 0,
          pending: 150,
          created: 100,
          updated: 0,
          actorName: "Ops Person",
          createdAt: Date.UTC(2026, 10, 11, 2),
          startedAt: null,
          finishedAt: null,
          interruptedAt: null,
          heartbeatAt: null,
        },
      ],
      next: null,
    },
    error: null,
  }),
  useLive: () => undefined,
}));

const {
  CustomerUpload,
  ErrorList,
  PreviewTable,
  RunHistory,
  RunReport,
  UploadStepper,
} = await import("./customer-upload");
const { downloadTemplateCsv } = await import("../../lib/customer-upload");

/** The lists the template's example row needs (shape of /customer-upload/reference). */
const ref = (
  list: string,
  code: string,
  name: string,
  parent: Partial<ReferenceRow> = {},
): ReferenceRow => ({
  list,
  salesOrgCode: "",
  channelCode: "",
  group1Code: "",
  code,
  name,
  ...parent,
});
const REFERENCE: ReferenceRow[] = [
  ref("tax_classification", "1", "Liable for Taxes"),
  ref("country", "PH", "Philippines"),
  ref("sales_organization", "1000", "SFI"),
  ref("sales_organization", "2000", "ARI"),
  ref("sales_office", "100", "SFI Cebu", { salesOrgCode: "1000" }),
  ref("distribution_channel", "30", "General Trade", { salesOrgCode: "1000" }),
  ref("distribution_channel", "20", "Food Service", { salesOrgCode: "2000" }),
  ref("customer_group_1", "KAS3", "Key Accounts 3", {
    salesOrgCode: "1000",
    channelCode: "30",
  }),
  ref("customer_group_2", "GGS", "GT-Grocery Stores", {
    salesOrgCode: "1000",
    channelCode: "30",
    group1Code: "KAS3",
  }),
  ref("customer_group", "74", "NO GROUP"),
  ref("type_of_business", "Sole Proprietor", "Sole Proprietor"),
  ref("payment_terms", "0003", "Due in 7 days"),
  ref("pricing_procedure", "2", "Standard Inclusive Tax"),
  ref("delivering_plant", "1000", "Cebu Production", { salesOrgCode: "1000" }),
];

const csvLine = (values: Record<string, string>) =>
  CUSTOMER_COLUMNS.map((c) => {
    const v = values[c.id] ?? "";
    return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
  }).join(",");
const csvWith = (...rows: Record<string, string>[]) =>
  customerTemplateCsv() + rows.map((r) => `${csvLine(r)}\r\n`).join("");
const example = (over: Record<string, string> = {}) => ({
  ...(EXAMPLE as Record<string, string>),
  ...over,
});
const bytes = (text: string) => new TextEncoder().encode(text);

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: "run-1",
  fileName: "north.xlsx",
  status: "completed",
  rowCount: 3,
  succeeded: 3,
  failed: 0,
  pending: 0,
  created: 2,
  updated: 1,
  actorName: "Ops",
  createdAt: 0,
  startedAt: null,
  finishedAt: null,
  interruptedAt: null,
  heartbeatAt: null,
  ...over,
});

describe("customer upload — the client's template", () => {
  it("header = Customer Code + the client's 51 labels in their order", () => {
    expect(CUSTOMER_HEADERS.length).toBe(52);
    expect(CUSTOMER_HEADERS[0]).toBe("Customer Code");
    expect(CUSTOMER_HEADERS.slice(1, 4)).toEqual([
      "Registered Name",
      "Trade Name",
      "Customer Name",
    ]);
    expect(CUSTOMER_HEADERS.at(-1)).toBe("Cluster Name");
    expect(CUSTOMER_HEADERS).not.toContain("customer_code");
    expect(columnLabel("shipTo.mobileNo")).toBe("Mobile No. (ship-to)");
  });
  it("CSV template download is the header line", () => {
    downloadTemplateCsv();
    expect(downloads.at(-1)?.name).toBe(
      "sunpride-customer-upload-template.csv",
    );
    expect(downloads.at(-1)?.content).toBe(customerTemplateCsv());
  });
});

describe("customer upload — reading and synchronous validation", () => {
  it("accepts the example row from CSV", async () => {
    const parsed = await parseCustomerFile("c.csv", bytes(csvWith(example())));
    expect(parsed.rows).toHaveLength(1);
    expect(syncValidate(parsed, REFERENCE)).toEqual({
      fileErrors: [],
      rowErrors: [],
    });
  });
  it("reads the generated .xlsx template with a filled row (Excel number cells too)", async () => {
    const wb = buildCustomerTemplateWorkbook(REFERENCE);
    const ws = wb.getWorksheet("Customers")!;
    CUSTOMER_COLUMNS.forEach((c, i) => {
      const v = example()[c.id] ?? "";
      ws.getCell(2, i + 1).value =
        c.id === "mobileNo" ? 9171234567 : c.id === "postalCode" ? 6000 : v;
    });
    const xlsx = new Uint8Array(await wb.xlsx.writeBuffer());
    const parsed = await parseCustomerFile("c.xlsx", xlsx);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.rows[0]?.rowNumber).toBe(2);
    expect(parsed.rows[0]?.values.postalCode).toBe("6000");
    expect(syncValidate(parsed, REFERENCE).rowErrors).toEqual([]);
  });
  it("lists missing and unknown columns", async () => {
    const header = [...CUSTOMER_HEADERS.slice(1), "Area"].join(",");
    const parsed = await parseCustomerFile("c.csv", bytes(`${header}\r\n`));
    const result = syncValidate(parsed, REFERENCE);
    expect(result.fileErrors[0]).toMatchObject({
      rowNumber: 1,
      code: "header_mismatch",
    });
    expect(result.fileErrors[0]?.message).toContain(
      "missing columns: Customer Code",
    );
    expect(result.fileErrors[0]?.message).toContain("unknown columns: Area");
  });
  it("ties each problem to row, client label and value; finds duplicates and dependent-list errors", async () => {
    const parsed = await parseCustomerFile(
      "c.csv",
      bytes(
        csvWith(
          example({ code: "A-1" }),
          example({
            code: "a-1",
            salesOrgCode: "ARI (2000)",
            mobileNo: "1234",
            "shipTo.contactPerson": "",
          }),
        ),
      ),
    );
    const { rowErrors } = syncValidate(parsed, REFERENCE);
    const brief = rowErrors.map((e) => `${e.rowNumber}:${e.label}:${e.code}`);
    expect(brief).toEqual(
      expect.arrayContaining([
        "3:Customer Code:duplicate_in_file",
        "3:Mobile No.:invalid_mobile",
        "3:Sales Office:not_for_sales_org",
        "3:Distribution Channel:not_for_sales_org",
        "3:Contact Person:required",
      ]),
    );
    expect(rowErrors.find((e) => e.code === "invalid_mobile")?.value).toBe(
      "1234",
    );
    expect(brief.filter((b) => b.startsWith("2:"))).toEqual([]);
  });
  it("flags an empty file", async () => {
    const parsed = await parseCustomerFile(
      "c.csv",
      bytes(customerTemplateCsv()),
    );
    expect(syncValidate(parsed, REFERENCE).fileErrors[0]?.code).toBe(
      "empty_file",
    );
  });
});

describe("customer upload — preview and reports", () => {
  const rows = [
    { rowNumber: 2, values: { code: "A-1", customerGroupCode: "74" } },
    { rowNumber: 3, values: { code: "A-2", customerGroupCode: "Nope" } },
  ];
  const errors = [
    {
      rowNumber: 3,
      column: "customerGroupCode",
      label: "Customer Group",
      code: "invalid_option",
      message: 'Customer Group "Nope" is not in the list.',
      value: "Nope",
    },
  ];
  it("marks the exact bad cell with its message on hover and inline", () => {
    const html = renderToStaticMarkup(
      <PreviewTable rows={rows} errors={errors} errorsOnly={false} />,
    );
    expect(html).toContain('data-row="3" data-invalid="true"');
    expect(html).toMatch(
      /data-column="customerGroupCode" data-error="invalid_option" title="Customer Group &quot;Nope&quot; is not in the list\."/,
    );
    expect(html).toContain(
      "Customer Group: Customer Group &quot;Nope&quot; is not in the list.",
    );
    expect(html).toContain(">Terms of payment<");
    expect(html).not.toContain('data-row="2" data-invalid');
  });
  it("filters to rows with problems", () => {
    const html = renderToStaticMarkup(
      <PreviewTable rows={rows} errors={errors} errorsOnly />,
    );
    expect(html).not.toContain('data-row="2"');
    expect(html).toContain('data-row="3"');
  });
  it("lists problems as row · client label (value): message", () => {
    const html = renderToStaticMarkup(<ErrorList errors={errors} />);
    expect(html).toContain("Row 3");
    expect(html).toContain("Customer Group");
    expect(html).toContain("Nope");
  });
  it("indexes errors by row and column", () => {
    expect(errorIndex(errors).get(3)?.get("customerGroupCode")?.[0]?.code).toBe(
      "invalid_option",
    );
  });
  it("merges batched server previews and recounts valid rows", () => {
    const merged = mergePreviews([
      {
        rowCount: 1,
        validCount: 1,
        errorRowCount: 0,
        newCount: 1,
        updateCount: 0,
        errors: [],
        rows: [
          { rowNumber: 2, customerCode: "A-1", action: "new", valid: true },
        ],
      },
      {
        rowCount: 1,
        validCount: 0,
        errorRowCount: 1,
        newCount: 0,
        updateCount: 0,
        errors,
        rows: [
          { rowNumber: 3, customerCode: "A-2", action: "update", valid: false },
        ],
      },
    ]);
    expect(merged).toMatchObject({
      rowCount: 2,
      validCount: 1,
      errorRowCount: 1,
      newCount: 1,
    });
  });
  it("errors CSV carries row, the client's label, value and message", () => {
    const csv = errorsCsv(errors);
    expect(csv).toContain("Row,Column,Value,Problem,Code");
    expect(csv).toContain(
      '3,Customer Group,Nope,"Customer Group ""Nope"" is not in the list.",invalid_option',
    );
  });
  it("report CSV: template columns + result + problem, pending rows explained", () => {
    const rowsDone: RunRow[] = [
      {
        rowNumber: 2,
        customerCode: "A-1",
        values: { code: "A-1" },
        action: "new",
        status: "succeeded",
        errors: [],
      },
      {
        rowNumber: 3,
        customerCode: "A-2",
        values: { code: "A-2" },
        action: null,
        status: "pending",
        errors: [],
      },
    ];
    const csv = reportCsv(rowsDone);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("Customer Code,Registered Name");
    expect(lines[0]).toContain("Result,Action,Problem column,Problem");
    expect(lines[1]).toContain("succeeded,new");
    expect(lines[2]).toContain("not processed");
    expect(lines[2]).toContain("Resume the upload");
  });
});

describe("customer upload — steps, result and history", () => {
  it("stepper marks done/current/todo", () => {
    const html = renderToStaticMarkup(<UploadStepper step={3} />);
    expect(html.match(/data-state="done"/g)).toHaveLength(2);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Preview");
  });
  it("step 1 offers the Excel template, the CSV version and the file picker; history below", () => {
    const html = renderToStaticMarkup(<CustomerUpload />);
    expect(html).toContain("Download template (Excel)");
    expect(html).toContain("CSV version");
    expect(html).toContain('accept=".xlsx,.csv"');
    expect(html).toContain("Customer Information template");
    expect(html).toContain("north.xlsx");
  });
  it("an interrupted run offers resume of only the unprocessed rows", () => {
    const html = renderToStaticMarkup(
      <RunReport
        run={run({
          status: "interrupted",
          succeeded: 100,
          pending: 150,
          rowCount: 250,
        })}
        rows={[]}
        onResume={() => undefined}
        onRetryFailed={() => undefined}
      />,
    );
    expect(html).toContain("Resume (150 rows)");
    expect(html).toContain("Rows already saved are kept");
  });
  it("a run with failed rows offers retry and lists the problems", () => {
    const html = renderToStaticMarkup(
      <RunReport
        run={run({ status: "completed_with_errors", failed: 1 })}
        rows={[
          {
            rowNumber: 4,
            customerCode: "A-3",
            values: {},
            action: null,
            status: "failed",
            errors: [
              {
                column: "salesPartnerCode",
                label: "Sales Partner",
                code: "invalid_option",
                message: 'Sales Partner "AG-9" is not in the list.',
                value: "AG-9",
              },
            ],
          },
        ]}
        onRetryFailed={() => undefined}
      />,
    );
    expect(html).toContain("Retry failed rows (1)");
    expect(html).toContain("Sales Partner");
    expect(html).toContain("Download report");
  });
  it("history shows who, file, new/updated/failed counts and status", () => {
    const html = renderToStaticMarkup(
      <RunHistory
        rows={[run({ actorName: "Ops Person", fileName: "march.xlsx" })]}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain("Ops Person");
    expect(html).toContain("march.xlsx");
    expect(html).toContain("Completed");
  });
});
