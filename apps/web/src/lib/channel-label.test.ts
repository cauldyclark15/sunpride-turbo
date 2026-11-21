import { describe, expect, it } from "vitest";
import { channelLabel } from "./channel-label";

describe("channelLabel (SP-0216)", () => {
  it("shows channel names, not raw codes", () => {
    expect(channelLabel("gt")).toBe("General trade");
    expect(channelLabel("kas")).toBe("Key accounts");
    expect(channelLabel("pmot")).toBe("Public market");
    expect(channelLabel("supermarket")).toBe("Supermarkets");
  });
  it("falls back for empty and unknown keys", () => {
    expect(channelLabel(null)).toBe("Default");
    expect(channelLabel("", "Default channel")).toBe("Default channel");
    expect(channelLabel("wet_market")).toBe("Wet market");
  });
});
