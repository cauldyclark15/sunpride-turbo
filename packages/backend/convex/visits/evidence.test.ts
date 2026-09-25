import { describe, expect, it } from "vitest";
import { matchesChecksum } from "./evidence";

describe("stored evidence checksum", () => {
  it("compares Convex base64 SHA-256 metadata against canonical hex and rejects mismatches", () => {
    const base64 = "VcZND81vnV98goCThX4/39poR4u06b0k1IHvORx4BOg=";
    const hex =
      "55c64d0fcd6f9d5f7c828093857e3fdfda68478bb4e9bd24d481ef391c7804e8";
    expect(matchesChecksum(base64, hex)).toBe(true);
    expect(matchesChecksum(base64, "a".repeat(64))).toBe(false);
    expect(matchesChecksum("garbage", hex)).toBe(false);
  });
});
