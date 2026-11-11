import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_TEMPLATE_SPEC,
  customerTemplateCsv,
} from "@sunpride/import-templates/customers";
import { parseCsv } from "../../lib/csv";
import {
  CUSTOMER_HEADERS,
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
          fileName: "north.csv",
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
const { downloadTemplate } = await import("../../lib/customer-upload");

const exampleCsv = customerTemplateCsv();
/** Template plus extra lines (already CSV-encoded). */
const csvWith = (...lines: string[]) =>
  exampleCsv + lines.map((l) => `${l}\r\n`).join("");
const exampleValues = CUSTOMER_TEMPLATE_SPEC.map((c) => c.example);
const lineWith = (over: Record<string, string>) =>
  CUSTOMER_HEADERS.map((h, i) =>
    h in over ? over[h] : (exampleValues[i] ?? ""),
  ).join(",");

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: "run-1",
  fileName: "north.csv",
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

describe("customer upload — synchronous validation", () => {
  it("accepts the downloaded template unchanged", () => {
    const parsed = parseCsv(exampleCsv, [...CUSTOMER_HEADERS]);
    expect(syncValidate(parsed)).toEqual({ fileErrors: [], rowErrors: [] });
  });
  it("downloads exactly the client template", () => {
    downloadTemplate();
    expect(downloads.at(-1)).toEqual({
      name: "sunpride-customers-template.csv",
      content: exampleCsv,
    });
  });
  it("rejects a re-ordered header as a file error before any row checks", () => {
    const swapped = exampleCsv.replace(
      "customer_code,customer_name",
      "customer_name,customer_code",
    );
    const result = syncValidate(parseCsv(swapped, [...CUSTOMER_HEADERS]));
    expect(result.fileErrors[0]).toMatchObject({
      rowNumber: 1,
      code: "header_mismatch",
    });
    expect(result.rowErrors).toEqual([]);
  });
  it("ties each problem to row, column and value, and finds duplicates in the file", () => {
    const parsed = parseCsv(
      csvWith(
        lineWith({ customer_code: "GT-000123", status: "closed" }),
        lineWith({
          customer_code: "NEW-1",
          owner_phone: "1234",
          latitude: "10.1",
          longitude: "",
          channel: "",
        }),
      ),
      [...CUSTOMER_HEADERS],
    );
    const { rowErrors } = syncValidate(parsed);
    const brief = rowErrors.map((e) => `${e.rowNumber}:${e.column}:${e.code}`);
    expect(brief).toEqual([
      "3:customer_code:duplicate_in_file",
      "3:status:invalid_status",
      "4:channel:required",
      "4:owner_phone:invalid_phone",
      "4:longitude:coordinates_incomplete",
    ]);
    expect(rowErrors[1]?.value).toBe("closed");
  });
  it("flags an empty file", () => {
    const parsed = parseCsv(`${CUSTOMER_HEADERS.join(",")}\r\n`, [
      ...CUSTOMER_HEADERS,
    ]);
    expect(syncValidate(parsed).fileErrors[0]?.code).toBe("empty_file");
  });
});

describe("customer upload — preview and reports", () => {
  const rows = [
    { rowNumber: 2, values: { customer_code: "A-1", channel: "GT" } },
    { rowNumber: 3, values: { customer_code: "A-2", channel: "Nope" } },
  ];
  const errors = [
    {
      rowNumber: 3,
      column: "channel",
      code: "unknown_channel",
      message: '"Nope" is not a channel.',
      value: "Nope",
    },
  ];
  it("marks the exact bad cell with its message on hover and inline", () => {
    const html = renderToStaticMarkup(
      <PreviewTable rows={rows} errors={errors} errorsOnly={false} />,
    );
    expect(html).toContain('data-row="3" data-invalid="true"');
    expect(html).toMatch(
      /data-column="channel" data-error="unknown_channel" title="&quot;Nope&quot; is not a channel\."/,
    );
    expect(html).toContain("channel: &quot;Nope&quot; is not a channel.");
    expect(html).not.toContain('data-row="2" data-invalid');
  });
  it("filters to rows with problems", () => {
    const html = renderToStaticMarkup(
      <PreviewTable rows={rows} errors={errors} errorsOnly />,
    );
    expect(html).not.toContain('data-row="2"');
    expect(html).toContain('data-row="3"');
  });
  it("lists problems as row · column (value): message", () => {
    const html = renderToStaticMarkup(<ErrorList errors={errors} />);
    expect(html).toContain("Row 3");
    expect(html).toContain("channel");
    expect(html).toContain("unknown_channel");
  });
  it("indexes errors by row and column", () => {
    expect(errorIndex(errors).get(3)?.get("channel")?.[0]?.code).toBe(
      "unknown_channel",
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
  it("errors CSV carries row, column, value, code and message", () => {
    expect(errorsCsv(errors)).toBe(
      'row_number,column,value,code,message\r\n3,channel,Nope,unknown_channel,"""Nope"" is not a channel."\r\n',
    );
  });
  it("report CSV keeps original columns and says what happened to every row", () => {
    const runRows: RunRow[] = [
      {
        rowNumber: 2,
        customerCode: "A-1",
        values: { customer_code: "A-1" },
        action: "new",
        status: "succeeded",
        errors: [],
      },
      {
        rowNumber: 3,
        customerCode: "A-2",
        values: { customer_code: "A-2" },
        action: null,
        status: "failed",
        errors: [
          {
            column: "area",
            code: "unknown_area",
            message: "Bad area.",
            value: "X",
          },
        ],
      },
      {
        rowNumber: 4,
        customerCode: "A-3",
        values: { customer_code: "A-3" },
        action: null,
        status: "pending",
        errors: [],
      },
    ];
    const lines = reportCsv(runRows).trim().split("\r\n");
    expect(lines[0]).toBe(
      `${CUSTOMER_HEADERS.join(",")},result,action,error_column,error_code,error_message`,
    );
    expect(lines[1]).toMatch(/^A-1,.*,succeeded,new,,,$/);
    expect(lines[2]).toMatch(/,failed,,area,unknown_area,Bad area\.$/);
    expect(lines[3]).toMatch(
      /,not processed,,,not_processed,The import stopped/,
    );
  });
});

describe("customer upload — stepper", () => {
  it("shows done, current and upcoming steps", () => {
    const html = renderToStaticMarkup(<UploadStepper step={3} />);
    expect(html.match(/data-state="done"/g)?.length).toBe(2);
    expect(html).toContain('aria-current="step" data-state="current"');
    expect(html).toContain("Preview");
    expect(html.match(/data-state="todo"/g)?.length).toBe(2);
  });
  it("starts at step 1 with the template download, file picker and history", () => {
    const html = renderToStaticMarkup(<CustomerUpload />);
    expect(html).toContain('data-step="1"');
    expect(html).toContain("Download template");
    expect(html).toContain('aria-label="Customer file"');
    expect(html).toContain("Upload history");
    expect(html).toContain("north.csv");
    expect(html).toContain("Interrupted");
  });
  it("result step offers resume for an interrupted run with live counts", () => {
    const html = renderToStaticMarkup(
      <RunReport
        run={run({
          status: "interrupted",
          rowCount: 250,
          succeeded: 100,
          pending: 150,
          created: 100,
          updated: 0,
        })}
        rows={[]}
        onResume={() => undefined}
        onRetryFailed={() => undefined}
      />,
    );
    expect(html).toContain("Resume (150 rows)");
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain('data-count="pending">150');
    expect(html).toContain("Download report");
  });
  it("result step offers retry for failed rows", () => {
    const html = renderToStaticMarkup(
      <RunReport
        run={run({ status: "completed_with_errors", succeeded: 2, failed: 1 })}
        rows={null}
        onRetryFailed={() => undefined}
      />,
    );
    expect(html).toContain("Retry failed rows (1)");
    expect(html).not.toContain("Resume");
  });
  it("history lists who, when, file, rows, succeeded, failed and status", () => {
    const html = renderToStaticMarkup(
      <RunHistory
        rows={[run({ actorName: "Maria" })]}
        onOpen={() => undefined}
      />,
    );
    for (const text of ["Maria", "north.csv", "Completed", ">3<", "Open"])
      expect(html).toContain(text);
  });
});
