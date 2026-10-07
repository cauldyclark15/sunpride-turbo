import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VOID_REASONS } from "../../../../packages/backend/convex/van/model";
import {
  pesosToCentavos,
  requestVoidCode,
  VAN_VOID_REASONS,
  VanVoidApproval,
} from "./van-void-approval";

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
const render = () => renderToStaticMarkup(createElement(VanVoidApproval));

beforeEach(() => {
  state.values = {
    "lib/capabilities:currentPermissions": {
      capabilities: ["van.void.approve"],
    },
  };
});

describe("van void approval (VAN-021)", () => {
  it("offers exactly the backend's void reasons", () => {
    expect(VAN_VOID_REASONS.map((reason) => reason.code)).toEqual([
      ...VOID_REASONS,
    ]);
  });

  it("converts an exact peso amount to centavos and refuses anything else", () => {
    expect(pesosToCentavos("1,234.50")).toBe("123450");
    expect(pesosToCentavos("₱ 1234.5")).toBe("123450");
    expect(pesosToCentavos("P12")).toBe("1200");
    expect(pesosToCentavos("0.01")).toBe("1");
    expect(pesosToCentavos("12.345")).toBeNull();
    expect(pesosToCentavos("-5")).toBeNull();
    expect(pesosToCentavos("")).toBeNull();
    expect(pesosToCentavos("abc")).toBeNull();
  });

  it("sends the trimmed receipt, centavos and reason; refuses an incomplete form", async () => {
    const issue = vi.fn(
      async (args: {
        receiptNumber: string;
        totalMinor: string;
        reasonCode: string;
      }) => ({ ...args, code: "12345678", tripNumber: "TRIP-1" }),
    ) as unknown as Parameters<typeof requestVoidCode>[0] &
      ReturnType<typeof vi.fn>;
    await expect(
      requestVoidCode(
        issue,
        form({
          receiptNumber: " TRIP-1-1A2B3C4D-0001 ",
          total: "1,234.50",
          reason: "wrong_items",
        }),
      ),
    ).resolves.toMatchObject({ code: "12345678" });
    expect(issue).toHaveBeenCalledWith({
      receiptNumber: "TRIP-1-1A2B3C4D-0001",
      totalMinor: "123450",
      reasonCode: "wrong_items",
    });
    await expect(
      requestVoidCode(issue, form({ total: "1", reason: "other" })),
    ).rejects.toThrow(/receipt number/);
    await expect(
      requestVoidCode(
        issue,
        form({ receiptNumber: "R", total: "1.234", reason: "other" }),
      ),
    ).rejects.toThrow(/total in pesos/);
    await expect(
      requestVoidCode(
        issue,
        form({ receiptNumber: "R", total: "1", reason: "mistake" }),
      ),
    ).rejects.toThrow(/reason/);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("renders the form only for a role with van.void.approve", () => {
    const html = render();
    expect(html).toContain("Van sale void approval");
    expect(html).toContain('name="receiptNumber"');
    expect(html).toContain("Customer cancelled");
    state.values["lib/capabilities:currentPermissions"] = {
      capabilities: ["order.approve"],
    };
    expect(render()).toBe("");
  });
});
