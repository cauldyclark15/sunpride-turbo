/**
 * Lint-style guard (WEB-142 / WEB-166): page components show dates through
 * `lib/format`, never through ad-hoc `toLocale*String` calls (numeric
 * "11/12/2026", browser-zone dates) or raw ISO text. New offenders fail here.
 *
 * Allowed: ISO strings for URLs, API bodies, CSV cells, file names and
 * <input type="date"> values — the checks below only look at display shapes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

/** BIR print documents keep their mandated layouts (bir-legal-selling). */
const EXEMPT = new Set([
  "components/ops/receipts/receipt-preview.tsx",
  "components/storepos/reading-sheet.tsx",
]);

const RULES: { name: string; pattern: RegExp }[] = [
  {
    name: "toLocaleDateString/toLocaleTimeString (use formatDate/formatTime)",
    pattern: /\.toLocale(Date|Time)String\(/,
  },
  {
    name: "new Date(…).toLocaleString (use formatDateTime)",
    pattern: /new Date\([^;]*?\)\s*\.toLocaleString\(/,
  },
  {
    name: "toISOString() rendered as JSX text",
    pattern: /[>}]\s*\{[^{}]*\.toISOString\(\)[^{}]*\}/,
  },
  {
    name: "raw period shown as `{from} → {to}` (use formatPeriod)",
    pattern: /\{[\w.?]+\.period(From|_from)\}\s*(→|–|-|to)/,
  },
  {
    name: "raw status underscore replace (use formatStatus)",
    pattern: /\.status\.replaceAll\("_", " "\)/,
  },
];

describe("no raw dates or enum words in page components", () => {
  const all = [...files(join(SRC, "components")), ...files(join(SRC, "app"))];
  it("scans the components", () => {
    expect(all.length).toBeGreaterThan(100);
  });
  for (const rule of RULES)
    it(rule.name, () => {
      const offenders: string[] = [];
      for (const path of all) {
        const rel = relative(SRC, path);
        if (EXEMPT.has(rel)) continue;
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (rule.pattern.test(line)) offenders.push(`${rel}:${i + 1}`);
          });
      }
      expect(offenders).toEqual([]);
    });
});
