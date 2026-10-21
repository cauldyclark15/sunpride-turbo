import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditStack,
  checkSource,
  isAllowed,
  RETIRED_NAME,
} from "./retired-stack-audit";

describe("retired stack repository gate", () => {
  test("rejects runtime, dependency, environment, comment and fixture references case-insensitively", () => {
    for (const file of [
      "apps/web/src/page.tsx",
      "package.json",
      ".env.example",
      "docs/runbooks/old.md",
      "test/fixture.json",
      "bun.lock",
      "apps/field-ios/project.yml",
    ]) {
      expect(
        checkSource(file, `first\n${RETIRED_NAME.toUpperCase()}\nlast`),
      ).toEqual([{ file, line: 2 }]);
    }
  });
  test("rejects a retired name in a filename even with empty content", () => {
    expect(checkSource(`src/${RETIRED_NAME}/client.ts`, "")).toHaveLength(1);
  });
  test("allows only the two exact lead-owned docs and any write-protected instructions", () => {
    for (const file of [
      "docs/architecture/BACKEND_V2.md",
      "docs/architecture/ANALYTICS_V2.md",
      "CLAUDE.md",
      "packages/backend/CLAUDE.md",
    ]) {
      expect(isAllowed(file)).toBe(true);
      expect(checkSource(file, RETIRED_NAME)).toEqual([]);
    }
    for (const file of [
      "docs/BACKEND_V2.md",
      "docs/architecture/BACKEND_V2.md.bak",
      "src/CLAUDE.md.ts",
      "AGENTS.md",
    ])
      expect(isAllowed(file)).toBe(false);
  });
  test("covers tracked and newly created files, skips removed files and binary artefacts", () => {
    const root = mkdtempSync(join(tmpdir(), "retired-stack-gate-"));
    try {
      expect(Bun.spawnSync(["git", "init", "--quiet", root]).exitCode).toBe(0);
      writeFileSync(join(root, "removed.ts"), "safe");
      expect(Bun.spawnSync(["git", "add", "."], { cwd: root }).exitCode).toBe(
        0,
      );
      rmSync(join(root, "removed.ts"));
      writeFileSync(join(root, "new.ts"), RETIRED_NAME);
      writeFileSync(join(root, "image.bin"), Buffer.from(`\0${RETIRED_NAME}`));
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "nested/CLAUDE.md"), RETIRED_NAME);
      expect(auditStack(root)).toEqual({
        checked: 1,
        findings: [{ file: "new.ts", line: 1 }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
