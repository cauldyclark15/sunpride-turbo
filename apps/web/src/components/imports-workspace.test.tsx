import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportsWorkspace } from "./imports-workspace";
import { OPERATIONAL_HEADERS, errorCsv } from "../lib/import-csv-export";
import {
  PRICE_HEADERS,
  TARGET_HEADERS,
  PRODUCT_MASTER_HEADERS,
  businessPayload,
  countSessionChunks,
} from "../lib/import-templates";
import { parseImportFile } from "../lib/csv";

const state = vi.hoisted(() => ({
  hooks: [] as unknown[],
  index: 0,
  buttons: {} as Record<string, () => void>,
  inputs: {} as Record<
    string,
    (event: { target: { value: string; files?: File[] } }) => void
  >,
  kinds: [
    "products",
    "opening_stock",
    "stock_adjustment",
    "cycle_count",
    "mcp",
  ],
  permissions: ["target.manage", "masterdata.manage"],
  calls: [] as unknown[],
  history: {
    rows: [] as {
      id: string;
      kind: string;
      status: string;
      rowCount: number;
      accepted: number;
      failed: number;
      createdAt: number;
      errors: unknown[];
    }[],
    next: null as string | null,
  },
  query: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
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
              ? (value as (x: unknown) => unknown)(state.hooks[index])
              : value;
        },
      ];
    },
  };
});
vi.mock("../lib/auth", () => ({
  usePermissions: () => ({
    can: (cap: string) => state.permissions.includes(cap),
  }),
  useSession: () => ({
    profile: { id: "user", active: true },
    me: { scope: { fingerprint: "scope" } },
  }),
}));
vi.mock("../lib/api", () => ({
  apiFetch: (...args: unknown[]) => state.query(...args),
  mutate: (...args: unknown[]) => state.mutation(...args),
  useLive: () => {},
  useApi: (key: unknown, fetcher: unknown) => {
    state.calls.push(key);
    if (!key) return { data: undefined };
    if (fetcher === "/api/v1/imports/options")
      return {
        data: {
          kinds: state.kinds,
          unavailable: ["stock_adjustment", "cycle_count"],
        },
      };
    if (fetcher === "/api/v1/imports/plans")
      return {
        data: {
          rows: [
            {
              id: "plan1",
              assignee: "Example Salesperson",
              month: "2026-10",
              version: 1,
            },
          ],
          truncated: false,
        },
      };
    return { data: state.history };
  },
}));
vi.mock("@heroui/react", () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
  }: {
    children: React.ReactNode;
    onPress?: () => void;
    isDisabled?: boolean;
  }) => {
    if (onPress && !isDisabled) state.buttons[String(children)] = onPress;
    return createElement("button", { disabled: isDisabled }, children);
  },
}));
vi.mock("@sunpride/ui", () => ({
  Card: ({ label, children }: { label: string; children: React.ReactNode }) =>
    createElement("section", null, createElement("h2", null, label), children),
}));
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const capture = (type: unknown, props: Record<string, unknown>) => {
    if (type === "button" && props.onClick)
      state.buttons[String(props["aria-label"])] = props.onClick as () => void;
    if ((type === "input" || type === "select") && props.onChange)
      state.inputs[String(props["aria-label"])] =
        props.onChange as (typeof state.inputs)[string];
  };
  return {
    ...actual,
    jsx: (type: unknown, props: Record<string, unknown>, key?: string) => {
      capture(type, props);
      return actual.jsx(type as never, props, key);
    },
    jsxs: (type: unknown, props: Record<string, unknown>, key?: string) => {
      capture(type, props);
      return actual.jsxs(type as never, props, key);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (
      type: unknown,
      props: Record<string, unknown>,
      key: string | undefined,
      staticChildren: boolean,
      source: unknown,
      self: unknown,
    ) => {
      if (type === "button" && props.onClick)
        state.buttons[String(props["aria-label"])] =
          props.onClick as () => void;
      if ((type === "input" || type === "select") && props.onChange)
        state.inputs[String(props["aria-label"])] =
          props.onChange as (typeof state.inputs)[string];
      return actual.jsxDEV(
        type as never,
        props,
        key,
        staticChildren,
        source as never,
        self,
      );
    },
  };
});
function render() {
  state.index = 0;
  state.buttons = {};
  state.inputs = {};
  return renderToStaticMarkup(
    createElement(ImportsWorkspace, { setupMessage: "Ready" }),
  );
}
function choose(label: string) {
  render();
  state.buttons[label]!();
  return render();
}
function field(label: string, value: string) {
  state.inputs[label]!({ target: { value } });
  render();
}
async function upload(text: string) {
  state.inputs["CSV or Excel file"]!({
    target: {
      value: "",
      files: [{ name: "upload.csv", text: async () => text } as File],
    },
  });
  await vi.waitFor(() => expect(render()).toContain("upload.csv"));
}
async function preview() {
  state.buttons["Preview file"]!();
  await vi.waitFor(() => expect(render()).toContain("valid ·"));
}
function download() {
  let blob: Blob | null = null;
  let name = "";
  vi.stubGlobal("URL", {
    createObjectURL: (file: Blob) => {
      blob = file;
      return "blob:test";
    },
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("document", {
    createElement: () => ({
      set href(_v: string) {},
      set download(v: string) {
        name = v;
      },
      click: vi.fn(),
    }),
  });
  return async () => ({ name, text: blob ? await (blob as Blob).text() : "" });
}
beforeEach(() => {
  state.hooks = [];
  state.index = 0;
  state.calls = [];
  state.kinds = [
    "products",
    "opening_stock",
    "stock_adjustment",
    "cycle_count",
    "mcp",
  ];
  state.permissions = ["target.manage", "masterdata.manage"];
  state.history = { rows: [], next: null };
  state.query.mockReset();
  state.mutation.mockReset();
  state.query.mockResolvedValue({
    accepted: 1,
    errors: [],
    lines: [],
    commitAvailable: true,
  });
  state.mutation.mockResolvedValue({
    accepted: 1,
    failed: 0,
    errors: [],
    duplicate: false,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("task-based API import workspace", () => {
  it("offers all seven tasks without exposing technical run ids", () => {
    const html = render();
    for (const label of [
      "Products",
      "Prices",
      "Opening stock",
      "Stock count",
      "Adjustments",
      "Route plans",
      "Sales targets",
    ])
      expect(state.buttons[label]).toBeDefined();
    expect(html).toContain("What do you want to load?");
  });
  it("shows scoped operational tasks but no national imports for managers", () => {
    state.kinds = ["stock_adjustment", "cycle_count"];
    state.permissions = [];
    const html = render();
    expect(state.buttons.Adjustments).toBeDefined();
    expect(state.buttons["Stock count"]).toBeDefined();
    expect(html).not.toContain(">Products<");
    expect(html).not.toContain(">Opening stock<");
  });
  it("hides denied types and never reads national history", () => {
    state.kinds = ["cycle_count"];
    state.permissions = [];
    choose("Stock count");
    expect(state.buttons.Adjustments).toBeUndefined();
    expect(state.calls).not.toContainEqual([
      "imports",
      "runs",
      "products",
      null,
    ]);
    expect(state.calls).toContainEqual([
      "imports",
      "runs",
      "cycle_count",
      null,
    ]);
  });
  it.each([
    [
      "Adjustments",
      "stock-adjustment.csv",
      OPERATIONAL_HEADERS.stock_adjustment,
    ],
    ["Stock count", "cycle-count.csv", OPERATIONAL_HEADERS.cycle_count],
  ])("downloads the exact %s template", async (label, filename, header) => {
    choose(label);
    const read = download();
    state.buttons.Template!();
    expect(await read()).toEqual({ name: filename, text: `${header}\r\n` });
  });
  it("shows original error row and plain message, with downloadable error codes", async () => {
    choose("Adjustments");
    await upload(
      `${OPERATIONAL_HEADERS.stock_adjustment}\nR,1,CORRECTION,COUNT,AAA,WH,available,,0,,`,
    );
    state.query.mockResolvedValue({
      accepted: 0,
      errors: [
        {
          rowNumber: 2,
          column: "quantity_delta",
          code: "zero_delta",
          message: "Enter a nonzero stock change.",
        },
      ],
    });
    await preview();
    expect(render()).toContain("Enter a nonzero stock change.");
    expect(render()).not.toContain(">zero_delta<");
    const read = download();
    state.buttons["Download errors"]!();
    expect((await read()).text).toContain("2,quantity_delta,zero_delta");
  });
  it("shows only counted quantities even when a response contains approver-only fields", async () => {
    choose("Stock count");
    await upload(
      `${OPERATIONAL_HEADERS.cycle_count}\nREF,WH,AAA,available,,3,,`,
    );
    state.query.mockResolvedValue({
      accepted: 1,
      errors: [],
      lines: [
        {
          rowNumber: 2,
          countedBase: 3,
          status: "valid",
          expectedBase: 9000,
          varianceBase: -8997,
        },
      ],
      approvalPartitions: [{ expectedBase: 9000 }],
    });
    await preview();
    const html = render();
    expect(html).toContain("Counted 3 base units");
    expect(html).not.toMatch(/expectedBase|variance|9,000|9000/);
  });
  it.each([
    [
      "Adjustments",
      OPERATIONAL_HEADERS.stock_adjustment,
      "R,1,CORRECTION,COUNT,AAA,WH,available,,1,,",
    ],
    [
      "Stock count",
      OPERATIONAL_HEADERS.cycle_count,
      "REF,WH,AAA,available,,3,,",
    ],
  ])(
    "does not pretend %s is connected when its owner seam is missing",
    async (label, header, row) => {
      choose(label);
      await upload(`${header}\n${row}`);
      state.query.mockResolvedValue({
        accepted: 1,
        errors: [],
        commitAvailable: false,
        notice: "Submission awaits Inventory. Nothing was changed.",
      });
      await preview();
      expect(state.buttons["Load rows"]).toBeUndefined();
      expect(render()).toContain("Nothing was changed.");
      expect(state.mutation).not.toHaveBeenCalled();
    },
  );
  it("shows preview failures inline and cancel clears the file", async () => {
    choose("Adjustments");
    await upload(
      `${OPERATIONAL_HEADERS.stock_adjustment}\nR,1,T,R,AAA,WH,available,,1,,`,
    );
    state.query.mockRejectedValue(new Error("Location is outside scope"));
    state.buttons["Preview file"]!();
    await vi.waitFor(() =>
      expect(render()).toContain("Location is outside scope"),
    );
    expect(state.buttons["Load rows"]).toBeUndefined();
    state.buttons.Cancel!();
    expect(render()).not.toContain("upload.csv");
  });
  it("renders persisted history errors and keeps paging through empty pages", () => {
    state.history = { rows: [], next: "50" };
    choose("Products");
    expect(state.buttons["More history"]).toBeDefined();
    state.buttons["More history"]!();
    render();
    expect(state.calls).toContainEqual(["imports", "runs", "products", "50"]);
  });
  it("loads valid route rows into the selected draft with original header and row numbers", async () => {
    choose("Route plans");
    field("Draft plan", "plan1");
    const header =
      "employee_code,territory_code,route_code,outlet_code,customer_code,service_date,frequency,sequence,duration_minutes,objectives";
    await upload(`${header}\n0007,T,R,0009,,2026-10-15,weekly,1,30,Visit`);
    await preview();
    expect(state.query.mock.calls[0]?.[1]).toMatchObject({
      body: {
        planId: "plan1",
        rows: [{ rowNumber: 2 }],
        header: header.split(","),
      },
    });
    state.buttons["Merge rows"]!();
    await vi.waitFor(() => expect(state.mutation).toHaveBeenCalled());
    expect(state.mutation.mock.calls[0]?.[1]).toMatchObject({
      planId: "plan1",
      chunkIndex: 0,
      rowCount: 1,
    });
  });
  it("refuses a mixed-invalid route chunk rather than merging a subset", async () => {
    choose("Route plans");
    field("Draft plan", "plan1");
    await upload(
      "employee_code,territory_code,route_code,outlet_code,customer_code,service_date,frequency,sequence,duration_minutes,objectives\n0007,T,R,UNKNOWN,,2026-10-15,weekly,1,30,Visit",
    );
    state.query.mockResolvedValue({
      accepted: 0,
      errors: [
        {
          rowNumber: 2,
          code: "unknown_reference",
          message: "Unknown active outlet.",
        },
      ],
    });
    await preview();
    expect(state.buttons["Merge rows"]).toBeUndefined();
    expect(render()).toContain("Unknown active outlet.");
  });
  it("hides route plans without permission", () => {
    state.kinds = ["cycle_count"];
    expect(render()).not.toContain(">Route plans<");
  });
  it("sends price-list import to the owner endpoint with integer centavos", async () => {
    choose("Prices");
    field("Price-list code", "EXAMPLE");
    field("Channel", "GT");
    field("Effective date (Manila)", "2026-10-20");
    await upload(`${PRICE_HEADERS.join(",")}\n001,PC,12345`);
    await preview();
    state.mutation.mockResolvedValue({ ok: true, errors: [] });
    state.buttons["Load rows"]!();
    await vi.waitFor(() => expect(state.mutation).toHaveBeenCalled());
    expect(state.query).not.toHaveBeenCalled();
    expect(state.mutation.mock.calls[0]?.[0]).toBe(
      "/api/v1/pricing/price-lists/import",
    );
    expect(state.mutation.mock.calls[0]?.[1]).toEqual({
      priceListCode: "EXAMPLE",
      channelKey: "GT",
      effectiveFrom: Date.parse("2026-10-20T00:00:00+08:00"),
      rows: [{ productCode: "001", uom: "PC", unitPriceCentavos: 12345 }],
    });
  });
  it("sends targets to analytics and renders owner row errors", async () => {
    choose("Sales targets");
    field("Target month", "2026-10");
    await upload(`${TARGET_HEADERS.join(",")}\nagent,agent-code,100000`);
    await preview();
    state.mutation.mockResolvedValue({
      ok: false,
      errors: [{ row: 2, message: "Agent is outside your scope." }],
    });
    state.buttons["Load rows"]!();
    await vi.waitFor(() =>
      expect(render()).toContain("Agent is outside your scope."),
    );
    expect(state.mutation.mock.calls[0]?.[0]).toBe("/api/v1/targets/import");
    expect(state.mutation.mock.calls[0]?.[1]).toEqual({
      month: "2026-10",
      rows: [{ level: "agent", key: "agent-code", amountCentavos: 100000 }],
    });
  });
  it("rejects decimal money and duplicate targets before any request", () => {
    const result = businessPayload(
      "targets",
      [
        {
          rowNumber: 2,
          values: { level: "agent", key: "A", amount_centavos: "1.2" },
        },
        {
          rowNumber: 3,
          values: { level: "agent", key: "A", amount_centavos: "3" },
        },
      ],
      {
        month: "2026-10",
        priceListCode: "",
        channelKey: "",
        effectiveFrom: "",
      },
    );
    expect(result.errors).toHaveLength(2);
  });
  it("invalidates preview after metadata changes", async () => {
    choose("Sales targets");
    field("Target month", "2026-10");
    await upload(`${TARGET_HEADERS.join(",")}\ncompany,company,0`);
    await preview();
    expect(state.buttons["Load rows"]).toBeDefined();
    field("Target month", "2026-11");
    expect(state.buttons["Load rows"]).toBeUndefined();
  });
  it("rejects reordered headers locally as invalid_format", async () => {
    const parsed = await parseImportFile(
      {
        name: "x.csv",
        text: async () => "key,level,amount_centavos\nA,agent,10",
      } as File,
      TARGET_HEADERS,
    );
    expect(parsed.errors[0]?.code).toBe("invalid_format");
  });
  it("uses SHA-256 file content identity independent of filename", async () => {
    const text = `${PRODUCT_MASTER_HEADERS.join(",")}\nAAA,Example,Example,PC,PC,,none,fifo,,N,N,,`;
    const a = await parseImportFile(
      { name: "a.csv", text: async () => text } as File,
      PRODUCT_MASTER_HEADERS,
    );
    const b = await parseImportFile(
      { name: "b.csv", text: async () => text } as File,
      PRODUCT_MASTER_HEADERS,
    );
    expect(a.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.fileHash).toBe(a.fileHash);
  });
  it("keeps interleaved count sessions whole and rejects over 100 lines", () => {
    const row = (reference: string, rowNumber: number) => ({
      rowNumber,
      values: { count_reference: reference },
    });
    expect(
      countSessionChunks([row("A", 2), row("B", 3), row("A", 4)]).map((x) =>
        x.map((r) => r.rowNumber),
      ),
    ).toEqual([[2, 4], [3]]);
    expect(() =>
      countSessionChunks(
        Array.from({ length: 101 }, (_, i) => row("A", i + 2)),
      ),
    ).toThrow("cannot be split");
  });
  it("protects spreadsheet formulas in downloadable errors", () => {
    expect(
      errorCsv([{ rowNumber: 2, code: "invalid", message: "=HYPERLINK(1)" }]),
    ).toContain("'=HYPERLINK(1)");
  });
});
