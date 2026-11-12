import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api/errors";
import { commandErrorText } from "./command-error";

describe("WEB-120 supervision commands show the API's refusal", () => {
  it("shows a 422 refusal as written", () => {
    expect(
      commandErrorText(
        new ApiError({
          code: "invalid",
          status: 422,
          message: "This position has no Work-With standard",
        }),
      ),
    ).toBe("This position has no Work-With standard");
  });
  it("keeps a retry sentence for a network failure", () => {
    expect(
      commandErrorText(new ApiError({ code: "network", status: 0, message: "fetch failed" })),
    ).toBe("Not saved. Check your connection and try again.");
  });
});
