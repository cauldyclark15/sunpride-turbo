import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestRefundCode,
  VAN_REFUND_REASONS,
  VanRefundApproval,
  type RefundCodeInput,
} from "./van-refund-approval";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
}));
vi.mock("../lib/auth", () => ({
  usePermissions: () => ({
    can: (capability: string) =>
      (
        state.values["permissions"] as { capabilities: string[] }
      )?.capabilities.includes(capability) ?? false,
  }),
}));
vi.mock("../lib/api", () => ({ mutate: vi.fn() }));

const form = (values: Record<string, string>) => ({
  get: (name: string) => values[name] ?? null,
});
const render = () => renderToStaticMarkup(createElement(VanRefundApproval));
const issued = (args: RefundCodeInput) => ({
  ...args,
  code: "12345678",
  tripNumber: "TRIP-1",
});

beforeEach(() => {
  state.values = {
    permissions: { capabilities: ["van.refund.approve"] },
  };
});

describe("van item refund approval (IP-REFUND)", () => {
  it("offers the five refund reasons the office seeds", () => {
    expect(VAN_REFUND_REASONS.map((r) => r.code)).toEqual([
      "RF-CHANGED-MIND",
      "RF-WRONG-ITEM",
      "RF-DAMAGED",
      "RF-EXPIRED",
      "RF-QUALITY",
    ]);
  });

  it("sends the trimmed receipt, centavos, reason code and refund number; refuses an incomplete form", async () => {
    const issue = vi.fn(async (args: RefundCodeInput) => issued(args));
    await expect(
      requestRefundCode(
        issue,
        form({
          receiptNumber: " TRIP-1-1A2B3C4D-0001 ",
          total: "125.25",
          reason: " RF-DAMAGED ",
          refundNumber: "2",
        }),
      ),
    ).resolves.toMatchObject({ code: "12345678" });
    expect(issue).toHaveBeenCalledWith({
      receiptNumber: "TRIP-1-1A2B3C4D-0001",
      totalMinor: "12525",
      reasonCode: "RF-DAMAGED",
      refundNumber: 2,
    });
    await expect(
      requestRefundCode(issue, form({ total: "1", reason: "RF-DAMAGED" })),
    ).rejects.toThrow(/receipt number/);
    await expect(
      requestRefundCode(
        issue,
        form({ receiptNumber: "R", total: "1.234", reason: "RF-DAMAGED" }),
      ),
    ).rejects.toThrow(/amount in pesos/);
    await expect(
      requestRefundCode(
        issue,
        form({ receiptNumber: "R", total: "0", reason: "RF-DAMAGED" }),
      ),
    ).rejects.toThrow(/amount in pesos/);
    await expect(
      requestRefundCode(
        issue,
        form({ receiptNumber: "R", total: "1", reason: "x" }),
      ),
    ).rejects.toThrow(/reason code/);
    await expect(
      requestRefundCode(
        issue,
        form({
          receiptNumber: "R",
          total: "1",
          reason: "RF-DAMAGED",
          refundNumber: "0",
        }),
      ),
    ).rejects.toThrow(/Enter which refund/);
    // the first refund of a receipt is the default
    await requestRefundCode(
      issue,
      form({ receiptNumber: "R", total: "1", reason: "RF-QUALITY" }),
    );
    expect(issue).toHaveBeenLastCalledWith(
      expect.objectContaining({ refundNumber: 1 }),
    );
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it("renders the form only for a role with van.refund.approve", () => {
    const html = render();
    expect(html).toContain("Van item refund approval");
    expect(html).toContain('name="receiptNumber"');
    expect(html).toContain("RF-DAMAGED");
    state.values["permissions"] = { capabilities: ["van.void.approve"] };
    expect(render()).toBe("");
  });
});
