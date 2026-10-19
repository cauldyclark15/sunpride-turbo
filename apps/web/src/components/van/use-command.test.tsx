import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { useVanCommand } from "./use-command";
import { mutate } from "../../lib/api";
vi.mock("../../lib/api", () => ({ mutate: vi.fn() }));
const mocked = vi.mocked(mutate);
function capture() {
  let command: ((p: { amountMinor: string }) => Promise<unknown>) | undefined;
  function Harness() {
    command = useVanCommand("/api/v1/van/cash/remit");
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return command!;
}
beforeEach(() => mocked.mockReset());
it("keeps the same command key and payload after an uncertain response", async () => {
  mocked
    .mockRejectedValueOnce(new Error("Transport interrupted"))
    .mockResolvedValue({ ok: true });
  const command = capture();
  await expect(command({ amountMinor: "10000" })).rejects.toThrow(
    "Transport interrupted",
  );
  await command({ amountMinor: "10000" });
  expect(mocked.mock.calls[0]?.[0]).toBe("/api/v1/van/cash/remit");
  expect(mocked.mock.calls[0]?.[2]?.idempotencyKey).toBe(
    mocked.mock.calls[1]?.[2]?.idempotencyKey,
  );
  expect(mocked.mock.calls[0]?.[2]?.invalidate).toEqual([["van"]]);
});
it("allocates a new key only when the user's captured facts change", async () => {
  mocked.mockResolvedValue({ ok: true });
  const command = capture();
  await command({ amountMinor: "10000" });
  await command({ amountMinor: "10001" });
  expect(mocked.mock.calls[0]?.[2]?.idempotencyKey).not.toBe(
    mocked.mock.calls[1]?.[2]?.idempotencyKey,
  );
});
it("does not send a command while rendering a form", () => {
  capture();
  expect(mocked).not.toHaveBeenCalled();
});
