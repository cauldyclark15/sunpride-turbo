import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Keeps docs/qa/SFA_UAT_SCENARIOS.md honest: every scenario names an automated
// convex-test that still exists, or says which part is manual only.
const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const catalogPath = resolve(repoRoot, "docs/qa/SFA_UAT_SCENARIOS.md");
const catalog = readFileSync(catalogPath, "utf8");

type Scenario = {
  id: string;
  body: string;
  automated: { file: string; name: string }[];
};

function scenarios(): Scenario[] {
  const heading = /^### (UAT-[A-Z0-9]+-\d{2}) · .+$/gm;
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

function testNames(file: string) {
  const source = readFileSync(resolve(repoRoot, file), "utf8");
  return [...source.matchAll(/\bit\(\s*"([^"]+)"/g)].map(([, name]) => name!);
}

describe("SFA UAT scenario catalogue", () => {
  const all = scenarios();

  it("lists unique scenario IDs, each on the sign-off sheet", () => {
    expect(all.length).toBeGreaterThanOrEqual(20);
    const ids = all.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const sheet = catalog.slice(catalog.indexOf("## Sign-off sheet"));
    for (const id of ids) expect(sheet).toContain(`| ${id} |`);
  });

  it("gives every scenario a role, expected result and an automated or manual marker", () => {
    for (const scenario of all) {
      expect(scenario.body, scenario.id).toMatch(/^- Role: /m);
      expect(scenario.body, scenario.id).toMatch(/^- Expected: /m);
      expect(
        scenario.automated.length > 0 ||
          /^- Manual only: /m.test(scenario.body),
        scenario.id,
      ).toBe(true);
    }
  });

  it("references convex-tests that still exist under their exact names", () => {
    for (const { id, automated } of all)
      for (const { file, name } of automated) {
        expect(file, id).toMatch(/\.test\.tsx?$/);
        expect(existsSync(resolve(repoRoot, file)), `${id}: ${file}`).toBe(
          true,
        );
        expect(testNames(file), `${id}: ${file}`).toContain(name);
      }
  });

  it("covers every acceptance area of SP-0026 and every end-to-end story test", () => {
    const areas = new Set(all.map((s) => s.id.split("-")[1]));
    for (const area of ["MCP", "VIS", "FLD", "ORD", "SAP", "SYN", "SUP"])
      expect(areas).toContain(area);
    const story =
      "packages/backend/convex/acceptance/sfa_pilot.acceptance.test.ts";
    const referenced = new Set(
      all.flatMap((s) =>
        s.automated.filter((a) => a.file === story).map((a) => a.name),
      ),
    );
    for (const name of testNames(story)) expect(referenced).toContain(name);
  });
});
