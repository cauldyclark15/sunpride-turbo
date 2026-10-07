import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Keeps docs/qa/VAN_SALES_UAT_SCENARIOS.md honest (SP-0120, QSR-002): every scenario
// names a test that still exists — server/web Vitest or handheld JVM/H10P Kotlin — or
// says which part is manual only.
const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const catalog = readFileSync(
  resolve(repoRoot, "docs/qa/VAN_SALES_UAT_SCENARIOS.md"),
  "utf8",
);
const STORY = "packages/backend/convex/acceptance/van_pilot.acceptance.test.ts";
const VAN_TESTS = "apps/van-sales-android/app/src/";

type Reference = { file: string; name: string };
type Scenario = { id: string; body: string; automated: Reference[] };

function scenarios(): Scenario[] {
  const heading = /^### (VUAT-[A-Z0-9]+-\d{2}) · .+$/gm;
  const marks = [...catalog.matchAll(heading)];
  return marks.map((mark, index) => {
    const end = marks[index + 1]?.index ?? catalog.indexOf("\n## ", mark.index);
    const body = catalog.slice(mark.index, end === -1 ? undefined : end);
    const automated = [
      ...body.matchAll(/^- Automated: `([^`]+)` — "([^"]+)"$/gm),
    ].map(([, file, name]) => ({ file: file!, name: name! }));
    return { id: mark[1]!, body, automated };
  });
}

/** Vitest `it("…")` names, or Kotlin `@Test fun name()` names. */
function testNames(file: string, source: string): string[] {
  if (file.endsWith(".kt"))
    return [
      ...source.matchAll(
        /@Test\s+(?:@\w+(?:\([^)]*\))?\s+)*fun\s+(?:`([^`]+)`|(\w+))/g,
      ),
    ].map(([, quoted, plain]) => (quoted ?? plain)!);
  return [...source.matchAll(/\bit\(\s*"([^"]+)"/g)].map(([, name]) => name!);
}

const read = (file: string) => readFileSync(resolve(repoRoot, file), "utf8");

describe("van-sales UAT scenario catalogue", () => {
  const all = scenarios();

  it("lists unique scenario IDs, each on the sign-off sheet", () => {
    expect(all.length).toBeGreaterThanOrEqual(30);
    const ids = all.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const sheet = catalog.slice(catalog.indexOf("## Sign-off sheet"));
    for (const id of ids) expect(sheet).toMatch(new RegExp(`\\| ${id} +\\|`));
    const rows = [...sheet.matchAll(/^\| (VUAT-[A-Z0-9]+-\d{2}) /gm)];
    expect(rows.map(([, id]) => id)).toEqual(ids);
  });

  it("gives every scenario a role, steps, expected result and an automated or manual marker", () => {
    for (const scenario of all) {
      expect(scenario.body, scenario.id).toMatch(/^- Role: /m);
      expect(scenario.body, scenario.id).toMatch(/^- Steps: /m);
      expect(scenario.body, scenario.id).toMatch(/^- Expected: /m);
      expect(
        scenario.automated.length > 0 ||
          /^- Manual only: /m.test(scenario.body),
        scenario.id,
      ).toBe(true);
      // Work not merged yet must say so and be run by hand until it lands.
      if (/^- Pending: /m.test(scenario.body)) {
        expect(scenario.body, scenario.id).toMatch(/^- Pending: SP-\d{4} /m);
        expect(scenario.body, scenario.id).toMatch(/^- Manual only: /m);
      }
    }
  });

  it("references tests that still exist under their exact names", () => {
    for (const { id, automated } of all)
      for (const { file, name } of automated) {
        const kotlin =
          file.startsWith(`${VAN_TESTS}test/`) ||
          file.startsWith(`${VAN_TESTS}androidTest/`);
        expect(
          kotlin ? file.endsWith(".kt") : /\.test\.tsx?$/.test(file),
          `${id}: ${file}`,
        ).toBe(true);
        expect(existsSync(resolve(repoRoot, file)), `${id}: ${file}`).toBe(
          true,
        );
        expect(testNames(file, read(file)), `${id}: ${file}`).toContain(name);
      }
  });

  it("covers every acceptance area of QSR-002 and every end-to-end story test", () => {
    const areas = new Set(all.map((s) => s.id.split("-")[1]));
    // Load, offline selling, printing, stock decrement, returns, damage, cash and stock
    // reconciliation, sync and trip close.
    for (const area of [
      "LOAD",
      "SELL",
      "PRT",
      "STK",
      "RET",
      "DMG",
      "CASH",
      "SCNT",
      "SYNC",
      "CLOSE",
    ])
      expect(areas).toContain(area);
    const referenced = new Set(
      all.flatMap((s) =>
        s.automated.filter((a) => a.file === STORY).map((a) => a.name),
      ),
    );
    const story = testNames(STORY, read(STORY));
    expect(story.length).toBeGreaterThanOrEqual(2);
    for (const name of story) expect(referenced).toContain(name);
    // Each story test is named after the scenario it automates.
    for (const name of story) {
      const id = /^(VUAT-[A-Z0-9]+-\d{2}) /.exec(name)?.[1];
      expect(id, name).toBeDefined();
      expect(
        all.find((s) => s.id === id)?.automated.some((a) => a.name === name),
        name,
      ).toBe(true);
    }
  });

  it("reads Kotlin test names, including backticked ones", () => {
    expect(
      testNames(
        "X.kt",
        '@Test fun plainName() {}\n@Test\n    @Ignore("x") fun `with spaces`() {}\nfun notATest() {}',
      ),
    ).toEqual(["plainName", "with spaces"]);
  });
});
