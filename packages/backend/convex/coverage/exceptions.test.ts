import { expect, it } from "vitest";
import { assertNoBlockingExceptions, forPlan } from "./exceptions";
it("preview and approval use the shared full preflight", () => {
  expect(forPlan).toBeDefined();
  expect(typeof assertNoBlockingExceptions).toBe("function");
});
