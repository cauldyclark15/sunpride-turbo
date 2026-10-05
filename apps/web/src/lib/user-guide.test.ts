import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isWebModuleSlug } from "../config/navigation";

// Keeps docs/training/SUPERVISOR_ADMIN_GUIDE.md (SP-0015) honest: every **bold** phrase in
// the guide is an on-screen label and must still exist in the web app or backend source,
// and every `/slug` it names must be a real web module.
const repoRoot = new URL("../../../../", import.meta.url);
const guide = readFileSync(
  new URL("docs/training/SUPERVISOR_ADMIN_GUIDE.md", repoRoot),
  "utf8",
);

const sourceRoots = [
  "apps/web/src",
  "packages/ui/src",
  "packages/backend/convex",
] as const;

function sourceFiles(dir: URL): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "_generated" || name === "node_modules") return [];
    const child = new URL(name, dir);
    if (statSync(child).isDirectory())
      return sourceFiles(new URL(`${name}/`, dir));
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)
      ? [child.pathname]
      : [];
  });
}

/** Source text with JSX entities decoded and line wrapping collapsed. */
const corpus = sourceRoots
  .flatMap((root) => sourceFiles(new URL(`${root}/`, repoRoot)))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n")
  .replaceAll("&apos;", "'")
  .replaceAll("&quot;", '"')
  .replaceAll("&amp;", "&")
  .replace(/\s+/g, " ");

const boldLabels = [
  ...new Set([...guide.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => match[1]!)),
];

/** Labels built at render time, mapped to the template that renders them. */
const computedLabels: Record<string, string> = {
  "Add BCP": "Add {area.toUpperCase()}",
  "Add PSF": "Add {area.toUpperCase()}",
  "Add training program": "Add {FORM_KIND_LABELS[kind].toLowerCase()}",
  "Add training sheet": "Add {FORM_KIND_LABELS[kind].toLowerCase()}",
  "Add job evaluation": "Add {FORM_KIND_LABELS[kind].toLowerCase()}",
};

describe("supervisor/admin user guide", () => {
  it("documents the issue's required topics", () => {
    // QSR-017: MCP planning, approvals, territory/route management, monitoring, exceptions.
    expect(guide).toMatch(/## \d+\. Master Coverage Plan \(MCP\)/);
    expect(guide).toMatch(/## \d+\. Reviewing, returning and approving/);
    expect(guide).toMatch(/## \d+\. Territories and routes/);
    expect(guide).toMatch(/## \d+\. Watching the field day/);
    expect(guide).toMatch(/## \d+\. Field exceptions/);
  });

  it("uses only on-screen labels that exist in the app", () => {
    expect(boldLabels.length).toBeGreaterThan(200);
    const missing = boldLabels.filter(
      (label) =>
        !corpus.includes(label.replace(/\s+/g, " ")) &&
        !corpus.includes(computedLabels[label] ?? "\u0000"),
    );
    expect(missing).toEqual([]);
    // Guard against a corpus that matches anything.
    expect(corpus.includes("Approve every plan at once")).toBe(false);
  });

  it("names only real web modules", () => {
    const slugs = [...guide.matchAll(/\(`\/([a-z-]+)`\)/g)].map(
      (match) => match[1]!,
    );
    expect(slugs.length).toBeGreaterThan(3);
    for (const slug of slugs) expect(isWebModuleSlug(slug), slug).toBe(true);
  });
});
