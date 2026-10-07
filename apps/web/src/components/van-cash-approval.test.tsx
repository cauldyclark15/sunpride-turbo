import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CASH_VARIANCE_REASONS } from "../../../../packages/backend/convex/van/model";
import {
  requestCashCode,
  VAN_CASH_VARIANCE_REASONS,
  VanCashApproval,
  varianceLabel,
} from "./van-cash-approval";

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
const render = () => renderToStaticMarkup(createElement(VanCashApproval));

beforeEach(() => {
  state.values = {
    "lib/capabilities:currentPermissions": {
      capabilities: ["van.cash.approve"],
    },
  };
});

describe("van cash count approval (VAN-022)", () => {
  it("offers exactly the backend's cash difference reasons", () => {
    expect(VAN_CASH_VARIANCE_REASONS.map((reason) => reason.code)).toEqual([
      ...CASH_VARIANCE_REASONS,
    ]);
  });

  it("describes a difference as short or over in pesos", () => {
    expect(varianceLabel("-14550")).toBe("₱145.50 short");
    expect(varianceLabel("600005")).toBe("₱6,000.05 over");
  });

  it("sends the trimmed trip number, centavos and reason; refuses an incomplete or matching form", async () => {
    const issue = vi.fn(
      async (args: {
        tripNumber: string;
        expectedMinor: string;
        declaredMinor: string;
        reasonCode: string;
      }) => ({ ...args, code: "12345678", varianceMinor: "-5000" }),
    ) as unknown as Parameters<typeof requestCashCode>[0] &
      ReturnType<typeof vi.fn>;
    await expect(
      requestCashCode(
        issue,
        form({
          tripNumber: " TRIP-20261007-V014-1 ",
          expected: "12,345.50",
          declared: "12,295.50",
          reason: "counting_error",
        }),
      ),
    ).resolves.toMatchObject({ code: "12345678" });
    expect(issue).toHaveBeenCalledWith({
      tripNumber: "TRIP-20261007-V014-1",
      expectedMinor: "1234550",
      declaredMinor: "1229550",
      reasonCode: "counting_error",
    });
    const base = {
      tripNumber: "T",
      expected: "100",
      declared: "40",
      reason: "other",
    };
    await expect(
      requestCashCode(issue, form({ ...base, tripNumber: "" })),
    ).rejects.toThrow(/trip number/);
    await expect(
      requestCashCode(issue, form({ ...base, expected: "1.234" })),
    ).rejects.toThrow(/expected cash/);
    await expect(
      requestCashCode(issue, form({ ...base, declared: "-4" })),
    ).rejects.toThrow(/counted cash/);
    await expect(
      requestCashCode(issue, form({ ...base, declared: "100.00" })),
    ).rejects.toThrow(/no approval/);
    await expect(
      requestCashCode(issue, form({ ...base, reason: "shrug" })),
    ).rejects.toThrow(/reason/);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("renders the form only for a role with van.cash.approve", () => {
    const html = render();
    expect(html).toContain("Van cash count approval");
    expect(html).toContain('name="tripNumber"');
    expect(html).toContain("Fake bill or coin");
    state.values["lib/capabilities:currentPermissions"] = {
      capabilities: ["van.void.approve"],
    };
    expect(render()).toBe("");
  });
});
