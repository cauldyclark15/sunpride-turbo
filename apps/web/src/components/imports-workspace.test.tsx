import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ImportsWorkspace } from "./imports-workspace";
import { OPERATIONAL_HEADERS, errorCsv } from "../lib/import-csv-export";
import { HEADER as ADJUSTMENT_HEADER } from "../../../../packages/backend/convex/imports/adjustments";
import { HEADER as COUNT_HEADER } from "../../../../packages/backend/convex/imports/counts";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  calls: [] as { name: string; args: unknown }[],
  buttons: {} as Record<string, () => void>,
  selects: {} as Record<string, (value: string) => void>,
  selectIndex: 0,
  fileInput: null as
    | null
    | ((event: {
        target: { files: { name: string; text: () => Promise<string> }[] };
      }) => void),
  hooks: [] as unknown[],
  index: 0,
  query: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    state.calls.push({ name, args });
    return args === "skip" ? undefined : state.values[name];
  },
  useConvex: () => ({ query: state.query, mutation: state.mutation }),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = state.index++;
      if (!(index in state.hooks))
        state.hooks[index] =
          typeof initial === "function"
            ? (initial as () => unknown)()
            : initial;
      return [
        state.hooks[index],
        (value: unknown) => {
          state.hooks[index] =
            typeof value === "function"
              ? (value as (prior: unknown) => unknown)(state.hooks[index])
              : value;
        },
      ];
    },
  };
});
vi.mock("@heroui/react", () => {
  const Select = Object.assign(
    ({
      children,
      "aria-label": label,
      onSelectionChange,
    }: {
      children: React.ReactNode;
      "aria-label": string;
      onSelectionChange: (key: string) => void;
    }) => {
      state.selects[label === "Draft plan" ? "plan" : "format"] =
        onSelectionChange;
      return createElement("div", null, children);
    },
    {
      Trigger: ({ children }: { children: React.ReactNode }) =>
        createElement("div", null, children),
      Value: () => null,
      Indicator: () => null,
      Popover: ({ children }: { children: React.ReactNode }) =>
        createElement("div", null, children),
    },
  );
  const ListBox = Object.assign(
    ({ children }: { children: React.ReactNode }) =>
      createElement("div", null, children),
    {
      Item: ({ children }: { children: React.ReactNode }) =>
        createElement("div", null, children),
    },
  );
  return {
    Select,
    ListBox,
    Button: ({
      children,
      onPress,
      isDisabled,
    }: {
      children: React.ReactNode;
      onPress?: () => void;
      isDisabled?: boolean;
    }) => {
      const label = String(children);
      if (onPress && !isDisabled) state.buttons[label] = onPress;
      return createElement("button", { disabled: isDisabled }, children);
    },
  };
});
vi.mock("@sunpride/ui", () => ({
  FormField: ({
    label,
    children,
  }: {
    label: string;
    children: React.ReactNode;
  }) => createElement("label", null, label, children),
  Card: ({
    label,
    count,
    actions,
    children,
  }: {
    label: string;
    count?: number;
    actions?: React.ReactNode;
    children: React.ReactNode;
  }) =>
    createElement(
      "section",
      null,
      createElement(
        "h2",
        null,
        `${label}${count === undefined ? "" : ` · ${count}`}`,
      ),
      actions,
      children,
    ),
  PageHeader: ({ title, meta }: { title: string; meta?: string }) =>
    createElement("header", null, title, meta),
  ListRow: ({
    title,
    meta,
    value,
  }: {
    title: React.ReactNode;
    meta?: React.ReactNode;
    value?: React.ReactNode;
  }) => createElement("div", null, title, meta, value),
  UnderlineTabs: ({
    items,
    onChange,
  }: {
    items: readonly (readonly [string, string])[];
    onChange: (key: string) => void;
  }) =>
    createElement(
      "nav",
      null,
      items.map(([key, label]) => {
        state.buttons[label] = () => onChange(key);
        return createElement(
          "button",
          { key, onClick: () => onChange(key) },
          label,
        );
      }),
    ),
  StatusPill: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
  EmptyPanel: ({ title }: { title: string }) => createElement("p", null, title),
  DataTable: ({
    rows,
    columns,
    empty,
  }: {
    rows: { id: string }[];
    columns: {
      key: string;
      label: string;
      render: (row: { id: string }) => React.ReactNode;
    }[];
    empty: React.ReactNode;
  }) =>
    rows.length
      ? createElement(
          "table",
          null,
          createElement(
            "thead",
            null,
            createElement(
              "tr",
              null,
              columns.map((column) =>
                createElement("th", { key: column.key }, column.label),
              ),
            ),
          ),
          createElement(
            "tbody",
            null,
            rows.map((row) =>
              createElement(
                "tr",
                { key: row.id },
                columns.map((column) =>
                  createElement("td", { key: column.key }, column.render(row)),
                ),
              ),
            ),
          ),
        )
      : empty,
}));

function render() {
  state.index = 0;
  state.buttons = {};
  state.selectIndex = 0;
  return renderToStaticMarkup(
    createElement(ImportsWorkspace, { setupMessage: "Ready" }),
  );
}
async function upload(kind: "Stock adjustment" | "Cycle count", csv: string) {
  render();
  state.buttons[kind]!();
  render();
  state.fileInput!({
    target: { files: [{ name: "upload.csv", text: async () => csv }] },
  });
  await Promise.resolve();
  render();
}

// A browserless file input mock captures onChange while retaining React's normal markup.
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  return {
    ...actual,
    jsx: (type: unknown, props: Record<string, unknown>, key?: string) => {
      if (type === "input" && props?.type === "file")
        state.fileInput = props.onChange as typeof state.fileInput;
      if (
        type === "button" &&
        typeof props?.onClick === "function" &&
        props?.children === "Template"
      )
        state.buttons["Template"] = props.onClick as () => void;
      if (type === "select" && typeof props?.onChange === "function") {
        const key = state.selectIndex++ === 0 ? "plan" : "format";
        state.selects[key] = (value) =>
          (props.onChange as (event: { target: { value: string } }) => void)({
            target: { value },
          });
      }
      if (
        type === "button" &&
        typeof props?.onClick === "function" &&
        typeof props?.children === "string"
      )
        state.buttons[props.children] = props.onClick as () => void;
      return actual.jsx(type as never, props, key);
    },
    jsxs: (type: unknown, props: Record<string, unknown>, key?: string) => {
      if (type === "select" && typeof props?.onChange === "function") {
        const name = state.selectIndex++ === 0 ? "plan" : "format";
        state.selects[name] = (value) =>
          (props.onChange as (event: { target: { value: string } }) => void)({
            target: { value },
          });
      }
      return actual.jsxs(type as never, props, key);
    },
  };
});

vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (
      type: unknown,
      props: Record<string, unknown>,
      key: string | undefined,
      isStatic: boolean,
      source: unknown,
      self: unknown,
    ) => {
      if (type === "input" && props?.type === "file")
        state.fileInput = props.onChange as typeof state.fileInput;
      if (
        type === "button" &&
        typeof props?.onClick === "function" &&
        props?.children === "Template"
      )
        state.buttons["Template"] = props.onClick as () => void;
      if (type === "select" && typeof props?.onChange === "function") {
        const name = state.selectIndex++ === 0 ? "plan" : "format";
        state.selects[name] = (value) =>
          (props.onChange as (event: { target: { value: string } }) => void)({
            target: { value },
          });
      }
      if (
        type === "button" &&
        typeof props?.onClick === "function" &&
        typeof props?.children === "string"
      )
        state.buttons[props.children] = props.onClick as () => void;
      return actual.jsxDEV(
        type as never,
        props,
        key,
        isStatic,
        source as never,
        self,
      );
    },
  };
});

function captureDownload() {
  let file: Blob | null = null;
  let filename = "";
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => {
      file = blob;
      return "blob:test";
    },
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("document", {
    createElement: () => ({
      set href(_value: string) {},
      set download(value: string) {
        filename = value;
      },
      click: vi.fn(),
    }),
  });
  return {
    read: async () => ({
      filename,
      content: file ? await (file as Blob).text() : "",
    }),
  };
}

beforeEach(() => {
  state.values = {
    "lib/capabilities:currentPermissions": {
      role: "super_admin",
      orgUnitId: null,
      capabilities: ["inventory.adjustment.request", "inventory.count.submit"],
    },
    "org/queries:tree": [],
    "imports/runs:list": [],
    "imports/operational_history:list": [],
  };
  state.hooks = [];
  state.calls = [];
  state.index = 0;
  state.query.mockReset();
  state.mutation.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe("ImportsWorkspace", () => {
  it("shows managers both operational uploads but no national import types", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      role: "manager",
      orgUnitId: "region",
      capabilities: ["inventory.adjustment.request", "inventory.count.submit"],
    };
    const html = render();
    expect(state.buttons["Stock adjustment"]).toBeDefined();
    expect(state.buttons["Cycle count"]).toBeDefined();
    expect(html).not.toContain("Product master");
    expect(html).not.toContain("Opening stock");
  });

  it("hides types without capability or national scope and skips national history", () => {
    state.values["lib/capabilities:currentPermissions"] = {
      role: "manager",
      orgUnitId: "region",
      capabilities: ["inventory.count.submit"],
    };
    const html = render();
    expect(html).toContain("Cycle count");
    expect(html).not.toContain("Stock adjustment");
    expect(html).not.toContain("Product master");
    state.buttons["Run history"]!();
    expect(render()).toContain("Adjustment and count runs");
    expect(state.calls).toContainEqual({
      name: "imports/runs:list",
      args: "skip",
    });
    expect(state.calls).toContainEqual({
      name: "imports/operational_history:list",
      args: {},
    });
  });

  it("keeps operational template headers in exact backend order", () => {
    expect(OPERATIONAL_HEADERS.stock_adjustment).toBe(ADJUSTMENT_HEADER);
    expect(OPERATIONAL_HEADERS.cycle_count).toBe(COUNT_HEADER);
    expect(`${OPERATIONAL_HEADERS.cycle_count}\r\n`).toBe(
      `${COUNT_HEADER}\r\n`,
    );
  });

  it.each([
    ["Stock adjustment", "stock-adjustment.csv", ADJUSTMENT_HEADER],
    ["Cycle count", "cycle-count.csv", COUNT_HEADER],
  ] as const)(
    "downloads the %s template with the backend header",
    async (kind, filename, header) => {
      render();
      state.buttons[kind]!();
      render();
      const download = captureDownload();
      state.buttons["Template"]!();
      expect(await download.read()).toEqual({
        filename,
        content: `${header}\r\n`,
      });
    },
  );

  it("previews adjustment totals and row errors with original numbers; exports codes and numbers", async () => {
    state.query.mockResolvedValue({
      accepted: 0,
      errorCount: 1,
      errors: [
        {
          rowNumber: 2,
          column: "quantity_delta",
          code: "zero_delta",
          message: "Zero",
        },
      ],
      partitions: [
        {
          productCode: "A",
          baseUomCode: "CASE",
          locationCode: "WH",
          stockStatus: "available",
          positiveBase: 1000n,
          negativeBase: 0n,
          netDeltaBase: 1000n,
          currentBase: 1000n,
          projectedBase: 2000n,
        },
      ],
      requestChunks: 0,
    });
    await upload(
      "Stock adjustment",
      `${ADJUSTMENT_HEADER}\nR,1,TYPE,REASON,A,WH,available,,0,,\n`,
    );
    await state.buttons["Preview file"]!();
    const html = render();
    expect(html).toContain("0 valid · 1 rejected");
    expect(html).toContain("Zero delta");
    expect(html).not.toContain(">zero_delta<");
    expect(html).toContain("Projected");
    expect(state.query.mock.calls[0]?.[1]).toMatchObject({
      header: ADJUSTMENT_HEADER.split(","),
      rows: [{ rowNumber: 2 }],
    });
    const download = captureDownload();
    state.buttons["Download errors"]!();
    expect(await download.read()).toEqual({
      filename: "stock_adjustment-errors.csv",
      content:
        "row_number,column,code,message\r\n2,quantity_delta,zero_delta,Zero\r\n",
    });
    expect(
      errorCsv([
        {
          rowNumber: 2,
          column: "quantity_delta",
          code: "zero_delta",
          message: "Zero",
        },
      ]),
    ).toContain("2,quantity_delta,zero_delta,Zero");
  });

  it("shows counted quantities only, even if an approver payload contains expected and variance", async () => {
    state.query.mockResolvedValue({
      accepted: 1,
      errorCount: 0,
      errors: [],
      lines: [
        {
          rowNumber: 2,
          countedBase: 3000n,
          status: "valid",
          expectedBase: 9000n,
          varianceBase: -6000n,
        },
      ],
      approvalPartitions: [{ expectedBase: 9000n, varianceBase: -6000n }],
    });
    await upload("Cycle count", `${COUNT_HEADER}\nREF,WH,A,available,,3,,\n`);
    await state.buttons["Preview file"]!();
    const html = render();
    expect(html).toContain("1 valid · 0 rejected");
    expect(html).toContain("Counted");
    expect(html).not.toMatch(/expected|variance|9,000|6,000/i);
  });

  it.each([
    [
      "Stock adjustment",
      ADJUSTMENT_HEADER,
      "Submit request",
      "imports/adjustments:commit",
    ],
    ["Cycle count", COUNT_HEADER, "Submit count", "imports/counts:commit"],
  ] as const)(
    "submits %s with original header and rows",
    async (kind, header, action, endpoint) => {
      state.query.mockResolvedValue({
        accepted: 1,
        errorCount: 0,
        errors: [],
        partitions: [],
        lines: [{ rowNumber: 2, countedBase: 1000n, status: "valid" }],
        requestChunks: 1,
      });
      state.mutation.mockResolvedValue({
        accepted: 1,
        failed: 0,
        duplicate: false,
        errors: [],
      });
      await upload(
        kind,
        `${header}\n${kind === "Cycle count" ? "REF,WH,A,available,,1,," : "REF,1,TYPE,REASON,A,WH,available,,1,,"}\n`,
      );
      await state.buttons["Preview file"]!();
      render();
      await state.buttons[action]!();
      expect(getFunctionName(state.mutation.mock.calls[0]![0])).toBe(endpoint);
      expect(state.mutation.mock.calls[0]![1]).toMatchObject({
        header: header.split(","),
        rowCount: 1,
        rows: [{ rowNumber: 2 }],
      });
      expect(render()).toContain(
        kind === "Cycle count" ? "counts submitted" : "submitted for approval",
      );
    },
  );

  it("shows preview failures inline and keeps submission disabled; cancel clears the file", async () => {
    state.query.mockRejectedValue(new Error("Location is outside scope"));
    await upload(
      "Stock adjustment",
      `${ADJUSTMENT_HEADER}\nREF,1,TYPE,REASON,A,WH,available,,1,,\n`,
    );
    await state.buttons["Preview file"]!();
    expect(render()).toContain("Location is outside scope");
    expect(state.buttons["Submit request"]).toBeUndefined();
    state.buttons.Cancel!();
    expect(render()).not.toContain("upload.csv");
  });

  it("renders national and scoped history tables without mixing data", () => {
    state.values["imports/runs:list"] = [
      {
        importType: "products",
        runKey: "national123",
        status: "completed",
        rowCount: 1,
        failedCount: 0,
        createdCount: 1,
        updatedCount: 0,
        movementIds: [],
        createdAt: 1,
      },
    ];
    state.values["imports/operational_history:list"] = [
      {
        importType: "stock_adjustment",
        runKey: "scoped123",
        status: "submitted",
        rowCount: 1,
        failedCount: 0,
        createdAt: 1,
      },
    ];
    render();
    state.buttons["Run history"]!();
    const html = render();
    expect(html).toContain("Product and stock runs");
    expect(html).toContain("Adjustment and count runs");
    expect(html).toContain("national");
    expect(html).toContain("scoped");
  });
  it("shows scoped MCP import, previews mixed CSV and merges accepted rows", async () => {
    state.values["lib/capabilities:currentPermissions"] = {
      role: "manager",
      orgUnitId: "region",
      capabilities: ["mcp.plan", "mcp.read"],
    };
    state.values["coverage/discovery:list"] = {
      page: [
        {
          planId: "plan1",
          assigneeName: "Sales",
          version: 1,
          localMonth: "2026-10",
          status: "draft",
        },
      ],
      isDone: true,
      continueCursor: "1",
    };
    state.values["imports/mcp:history"] = {
      page: [],
      isDone: true,
      continueCursor: "0",
    };
    render();
    state.buttons["Route sheets"]!();
    expect(render()).toContain("Draft plan");
    expect(state.calls).toContainEqual({
      name: "imports/mcp:history",
      args: "skip",
    });
    state.selects.plan!("plan1");
    render();
    const header =
      "employee_code,territory_code,route_code,outlet_code,customer_code,service_date,frequency,sequence,duration_minutes,objectives";
    state.fileInput!({
      target: {
        files: [
          {
            name: "sheet.csv",
            text: async () =>
              `${header}\n0007,T,R,0009,,2026-10-15,weekly,1,30,Visit\n0007,T,R,NO-SUCH-OUTLET,,2026-10-15,weekly,2,30,Visit\n`,
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.query.mockResolvedValue({
      accepted: [
        { rowNumber: 2, employeeId: "p", outletId: "o", territoryId: "t" },
      ],
      rejected: [
        {
          rowNumber: 3,
          column: "outlet_code",
          code: "unknown_reference",
          message: "Unknown local code",
        },
      ],
      fileHash: "hash",
      rowCount: 2,
    });
    state.mutation.mockResolvedValue({
      acceptedCount: 1,
      rejectedCount: 1,
      errors: [],
      duplicate: false,
      runId: "run",
    });
    await vi.waitFor(() => expect(render()).toContain("sheet.csv"));
    await state.buttons["Preview file"]!();
    expect(render()).toContain("1 accepted");
    expect(render()).toContain("Unknown reference");
    await state.buttons["Merge rows"]!();
    expect(state.query.mock.calls[0]?.[1]).toMatchObject({
      planId: "plan1",
      rows: [{ rowNumber: 2 }, { rowNumber: 3 }],
    });
    expect(state.mutation.mock.calls[0]?.[1]).toMatchObject({
      planId: "plan1",
      chunkIndex: 0,
      rowCount: 2,
    });
    expect(render()).toContain("rows merged");
  });
  it("hides MCP without mcp.plan and disables commit for all rejected", async () => {
    state.values["lib/capabilities:currentPermissions"] = {
      role: "manager",
      orgUnitId: "region",
      capabilities: ["inventory.count.submit"],
    };
    expect(render()).not.toContain("Route sheets");
    state.values["lib/capabilities:currentPermissions"] = {
      role: "manager",
      orgUnitId: "region",
      capabilities: ["mcp.plan"],
    };
    state.values["coverage/discovery:list"] = {
      page: [
        {
          planId: "plan1",
          assigneeName: "Sales",
          version: 1,
          localMonth: "2026-10",
        },
      ],
      isDone: true,
      continueCursor: "",
    };
    render();
    state.buttons["Route sheets"]!();
    state.hooks.splice(3);
    render();
    state.selects.plan!("plan1");
    render();
    state.fileInput!({
      target: {
        files: [
          {
            name: "sheet.csv",
            text: async () =>
              "employee_code,territory_code,route_code,outlet_code,customer_code,service_date,frequency,sequence,duration_minutes,objectives\n0007,T,R,X,,2026-10-15,weekly,1,30,Visit\n",
          },
        ],
      },
    });
    await vi.waitFor(() => expect(render()).toContain("sheet.csv"));
    state.query.mockResolvedValue({
      accepted: [],
      rejected: [
        {
          rowNumber: 2,
          code: "unknown_reference",
          column: "outlet_code",
          message: "Unknown",
        },
      ],
      fileHash: "hash",
      rowCount: 1,
    });
    await state.buttons["Preview file"]!();
    render();
    expect(state.buttons["Merge rows"]).toBeUndefined();
  });
});
