import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Keeps docs/qa/OFFLINE_CHAOS_TESTS.md honest (SP-0025): every chaos scenario names
// automated tests that still exist, across the server, Android and iPhone suites.
const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const catalog = readFileSync(
  resolve(repoRoot, "docs/qa/OFFLINE_CHAOS_TESTS.md"),
  "utf8",
);

function scenarios() {
  const marks = [...catalog.matchAll(/^### (CHAOS-\d{2}) · .+$/gm)];
  return marks.map((mark, index) => {
    const end = marks[index + 1]?.index ?? catalog.indexOf("\n## ", mark.index);
    const body = catalog.slice(mark.index, end === -1 ? undefined : end);
    const automated = [
      ...body.matchAll(/^- Automated: `([^`]+)` — "([^"]+)"$/gm),
    ].map(([, file, name]) => ({ file: file!, name: name! }));
    return { id: mark[1]!, body, automated };
  });
}

/** Test names per language: vitest `it("…")`, JUnit `@Test fun …`, XCTest `func test…`. */
function testNames(file: string) {
  const source = readFileSync(resolve(repoRoot, file), "utf8");
  const pattern = file.endsWith(".kt")
    ? /@Test\s+fun\s+(\w+)\s*\(/g
    : file.endsWith(".swift")
      ? /\bfunc\s+(test\w+)\s*\(/g
      : /\bit\(\s*"([^"]+)"/g;
  return [...source.matchAll(pattern)].map(([, name]) => name!);
}

describe("offline chaos scenario catalogue", () => {
  const all = scenarios();

  it("lists unique scenarios, each with transactions, a fault, an expected result and a device check", () => {
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
    for (const { id, body, automated } of all) {
      expect(body, id).toMatch(/^- Transactions: /m);
      expect(body, id).toMatch(/^- Fault: /m);
      expect(body, id).toMatch(/^- Expected: /m);
      expect(body, id).toMatch(/^- Device check: /m);
      expect(automated.length, id).toBeGreaterThan(0);
    }
  });

  it("references server, Android and iPhone tests that still exist under their exact names", () => {
    for (const { id, automated } of all)
      for (const { file, name } of automated) {
        expect(file, id).toMatch(/\.(test\.tsx?|kt|swift)$/);
        expect(existsSync(resolve(repoRoot, file)), `${id}: ${file}`).toBe(
          true,
        );
        expect(testNames(file), `${id}: ${file}`).toContain(name);
      }
  });

  it("covers every fault in the acceptance criteria on all three platforms", () => {
    const files = new Set(all.flatMap((s) => s.automated.map((a) => a.file)));
    for (const suite of [
      "packages/backend/convex/mobile/chaos.test.ts",
      "apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt",
      "apps/field-ios/FieldIOSTests/ChaosSyncTests.swift",
    ]) {
      expect(files).toContain(suite);
      // Every test in each chaos suite is catalogued, so none silently drops out.
      const named = new Set(
        all.flatMap((s) =>
          s.automated.filter((a) => a.file === suite).map((a) => a.name),
        ),
      );
      for (const name of testNames(suite)) expect(named, suite).toContain(name);
    }
    for (const fault of [
      /airplane mode/i,
      /intermittent|lost acknowledgement|drops/i,
      /long offline/i,
      /restart/i,
      /reconnect/i,
    ])
      expect(all.some((s) => fault.test(s.body))).toBe(true);
  });
});
