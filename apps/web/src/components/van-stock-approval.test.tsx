import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCountCode as backendNormalize } from "../../../../packages/backend/convex/van/stock_count";
import {
  groupedCountCode,
  normalizeCountCode,
  requestStockCode,
  VanStockApproval,
} from "./van-stock-approval";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
}));
vi.mock("convex/react", () => ({
  useQuery: (reference: unknown, args: unknown) =>
    args === "skip"
      ? undefined
      : state.values[getFunctionName(reference as never)],
  useMutation: () => vi.fn(),
}));

const form = (values: Record<string, string>) => ({
  get: (name: string) => values[name] ?? null,
});
const render = () => renderToStaticMarkup(createElement(VanStockApproval));

beforeEach(() => {
  state.values = {
    "lib/capabilities:currentPermissions": {
      capabilities: ["van.stock.approve"],
    },
  };
});

describe("van stock count approval (VAN-023)", () => {
  it("normalizes a read-out count code exactly like the backend", () => {
    for (const input of [
      "7acd-2b0f-a14f",
      " 7ACD 2B0F A14F ",
      "7ACD2B0FA14F",
      "7ACD-2B0F-A14",
      "7ACD-2B0F-A14G",
      "",
    ])
      expect(normalizeCountCode(input)).toBe(backendNormalize(input));
    expect(groupedCountCode("7ACD2B0FA14F")).toBe("7ACD-2B0F-A14F");
  });

  it("sends the trimmed trip number, normalized code and whole units; refuses an incomplete or matching form", async () => {
    const issue = vi.fn(
      async (args: {
        tripNumber: string;
        countCode: string;
        varianceLines: number;
        shortBase: string;
        overBase: string;
      }) => ({ ...args, code: "12345678" }),
    ) as unknown as Parameters<typeof requestStockCode>[0] &
      ReturnType<typeof vi.fn>;
    await expect(
      requestStockCode(
        issue,
        form({
          tripNumber: " TRIP-20261007-V014-1 ",
          countCode: "7acd-2b0f-a14f",
          varianceLines: "2",
          short: "2",
          over: "03",
        }),
      ),
    ).resolves.toMatchObject({ code: "12345678" });
    expect(issue).toHaveBeenCalledWith({
      tripNumber: "TRIP-20261007-V014-1",
      countCode: "7ACD2B0FA14F",
      varianceLines: 2,
      shortBase: "2",
      overBase: "3",
    });
    const base = {
      tripNumber: "T",
      countCode: "ABCDEF123456",
      varianceLines: "1",
      short: "1",
      over: "0",
    };
    await expect(
      requestStockCode(issue, form({ ...base, tripNumber: "" })),
    ).rejects.toThrow(/trip number/);
    await expect(
      requestStockCode(issue, form({ ...base, countCode: "ABC" })),
    ).rejects.toThrow(/count code/);
    await expect(
      requestStockCode(issue, form({ ...base, varianceLines: "0" })),
    ).rejects.toThrow(/lines differ/);
    await expect(
      requestStockCode(issue, form({ ...base, short: "1.5" })),
    ).rejects.toThrow(/units short/);
    await expect(
      requestStockCode(issue, form({ ...base, over: "-1" })),
    ).rejects.toThrow(/units over/);
    await expect(
      requestStockCode(issue, form({ ...base, short: "0", over: "0" })),
    ).rejects.toThrow(/no approval/);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("renders the form only for a role with van.stock.approve", () => {
    const html = render();
    expect(html).toContain("Van stock count approval");
    expect(html).toContain('name="countCode"');
    expect(html).toContain("Lines that differ");
    state.values["lib/capabilities:currentPermissions"] = {
      capabilities: ["van.cash.approve"],
    };
    expect(render()).toBe("");
  });
});
