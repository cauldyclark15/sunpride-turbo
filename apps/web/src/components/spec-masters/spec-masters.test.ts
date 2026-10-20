import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  MIGRATION_HEADERS,
  isMigration,
  migrationPesos,
} from "./migration-model";
import { MASTER_SECTIONS, masterEffectiveDate } from "./model";

describe("F-022 governed cutover templates", () => {
  it("F-022 browser headers match the pure server authority without importing its runtime", () => {
    const source = readFileSync(
      new URL(
        "../../../../api/src/domains/imports/migration-headers.js",
        import.meta.url,
      ),
      "utf8",
    );
    for (const [kind, header] of Object.entries(MIGRATION_HEADERS)) {
      expect(source).toContain(`${kind}:`);
      expect(source).toContain(header);
      expect(isMigration(kind)).toBe(true);
    }
    expect(isMigration("opening_stock")).toBe(false);
    expect(isMigration("__proto__")).toBe(false);
  });
  it("F-022 money remains exact beyond the JavaScript safe-integer range", () => {
    expect(migrationPesos("0")).toBe("₱0.00");
    expect(migrationPesos("75025")).toBe("₱750.25");
    expect(migrationPesos("900719925474099301")).toBe(
      "₱9,007,199,254,740,993.01",
    );
    expect(migrationPesos("-101")).toBe("−₱1.01");
  });
});
describe("F-009/F-010/F-013/F-014/F-017/F-305 master maintenance", () => {
  it("F-009 dates resolve in Manila instead of the browser timezone", () => {
    expect(masterEffectiveDate("2030-03-01T08:30")).toBe(
      Date.UTC(2030, 2, 1, 0, 30),
    );
    expect(masterEffectiveDate("")).toBeNull();
    expect(() => masterEffectiveDate("not-a-date")).toThrow();
  });
  it("F-017/F-305 every governed definition has an existing-shell maintenance section", () => {
    expect(MASTER_SECTIONS.map((s) => s[0])).toEqual([
      "geography",
      "beat",
      "channel",
      "subchannel",
      "class_policy",
      "msl",
      "chain",
      "banner",
      "branch",
    ]);
  });
});
