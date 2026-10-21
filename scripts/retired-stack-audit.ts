#!/usr/bin/env bun
/** Reject retired-backend references in repository source, docs and configuration. */
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { basename, join } from "node:path";

// Split only so the guard does not match itself. Native binary gates use the same word.
export const RETIRED_NAME = ["con", "vex"].join("");
const ALLOWED_DOCS = new Set([
  "docs/architecture/BACKEND_V2.md",
  "docs/architecture/ANALYTICS_V2.md",
]);
export const isAllowed = (path: string) =>
  basename(path) === "CLAUDE.md" || ALLOWED_DOCS.has(path);
export type StackFinding = { file: string; line: number };

/** Match names as well as contents; report locations only, never source/credential values. */
export function checkSource(file: string, text: string): StackFinding[] {
  if (isAllowed(file)) return [];
  const findings: StackFinding[] = [];
  if (file.toLowerCase().includes(RETIRED_NAME))
    findings.push({ file, line: 0 });
  for (const [index, line] of text.split(/\r?\n/).entries())
    if (line.toLowerCase().includes(RETIRED_NAME))
      findings.push({ file, line: index + 1 });
  return findings;
}

/** Include tracked and new non-ignored files; never follow dependency or credential symlinks. */
export function auditStack(root: string) {
  const result = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  );
  if (result.exitCode !== 0)
    throw new Error("Cannot enumerate repository files");
  const findings: StackFinding[] = [];
  let checked = 0;
  for (const file of new Set(
    result.stdout.toString().split("\0").filter(Boolean),
  )) {
    const path = join(root, file);
    if (isAllowed(file) || !existsSync(path) || !lstatSync(path).isFile())
      continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue; // Same binary exclusion as git's text search.
    checked++;
    findings.push(...checkSource(file, bytes.toString("utf8")));
  }
  return { checked, findings };
}

if (import.meta.main) {
  const { checked, findings } = auditStack(join(import.meta.dir, ".."));
  if (findings.length) {
    console.error(
      `Retired stack audit failed: ${findings.length} reference(s).`,
    );
    for (const { file, line } of findings) console.error(`${file}:${line}`);
    process.exitCode = 1;
  } else
    console.log(
      `Retired stack audit passed: ${checked} text files, 0 forbidden references.`,
    );
}
