import { describe, expect, it } from "vitest";
import { levelEditable } from "./targets-editor";

describe("targets editor level access (WEB-035)", () => {
  it("offers cells only when the server says this level is writable for the scope", () => {
    expect(levelEditable(true, { editable: false })).toBe(false);
    expect(levelEditable(true, { editable: true })).toBe(true);
    expect(levelEditable(false, { editable: true })).toBe(false);
    // Older responses without the flag keep the previous behaviour.
    expect(levelEditable(true, {})).toBe(true);
    expect(levelEditable(true, undefined)).toBe(true);
  });
});
