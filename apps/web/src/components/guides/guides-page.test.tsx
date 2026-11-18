import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  GUIDE_FILES,
  GUIDE_GROUPS,
  absoluteGuideUrl,
  downloadName,
} from "../../config/guides";
import { canAccessWebModule, APP_ROLES } from "../../lib/module-access";
import { getWebNavigation, primaryIdFor } from "../../config/navigation";
import { GuidesLink, GuidesPage, copyGuideLink } from "./guides-page";

const publicDir = fileURLToPath(new URL("../../../public", import.meta.url));

describe("Guides page (SP-0201)", () => {
  const html = renderToStaticMarkup(createElement(GuidesPage));

  it("has the three audience groups in order", () => {
    expect(GUIDE_GROUPS.map((g) => g.title)).toEqual([
      "For salesmen",
      "For managers",
      "For the office",
    ]);
    let at = -1;
    for (const group of GUIDE_GROUPS) {
      const next = html.indexOf(`>${group.title}</h2>`);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
  });

  it("renders every item with title, line, Open in a new tab, Download and copy link", () => {
    for (const group of GUIDE_GROUPS) {
      expect(group.guides.length).toBeGreaterThan(0);
      for (const guide of group.guides) {
        expect(html).toContain(guide.title.replace("'", "&#x27;"));
        expect(html).toContain(guide.line.replace("'", "&#x27;"));
        expect(html).toContain(
          `href="${guide.href}" target="_blank" rel="noopener"`,
        );
        expect(html).toContain(
          `href="${guide.href}" download="${downloadName(guide.href)}"`,
        );
        expect(html).toContain(`data-testid="copy-${guide.id}"`);
      }
    }
    const items = GUIDE_GROUPS.reduce((n, g) => n + g.guides.length, 0);
    expect(html.match(/>Open<\/a>/g)).toHaveLength(items);
    expect(html.match(/>Download<\/a>/g)).toHaveLength(items);
  });

  it("lists the how-tos the issue asks for", () => {
    const titles = GUIDE_GROUPS.flatMap((g) => g.guides.map((x) => x.title));
    for (const want of [
      "Install the Field app (Google Play)",
      "Update the Field app",
      "Forgot password / temporary password",
      "Set a person's app mode",
      "How to add customers",
    ])
      expect(titles).toContain(want);
  });

  it("every file exists in public/ as a real PDF with a stable, URL-friendly name", () => {
    expect(GUIDE_FILES.length).toBeGreaterThan(5);
    for (const href of GUIDE_FILES) {
      expect(href).toMatch(/^\/docs\/[a-z0-9-]+\.pdf$/);
      const file = `${publicDir}${href}`;
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file).subarray(0, 5).toString()).toBe("%PDF-");
    }
  });

  it("copy link copies the absolute address on the current site", async () => {
    const writeText = vi.fn(async () => undefined);
    const copied = await copyGuideLink(
      "/docs/sunpride-add-customers.pdf",
      "https://sunpride.cauldnclark.com",
      { writeText },
    );
    expect(copied).toBe(
      "https://sunpride.cauldnclark.com/docs/sunpride-add-customers.pdf",
    );
    expect(writeText).toHaveBeenCalledWith(copied);
    expect(
      absoluteGuideUrl("http://localhost:5181", "/docs/sunpride-x.pdf"),
    ).toBe("http://localhost:5181/docs/sunpride-x.pdf");
    await expect(
      copyGuideLink("/docs/a.pdf", "http://x", undefined),
    ).rejects.toThrow("Copy is not available");
    // No Clipboard API (or it refuses): the text-box fallback gets the same absolute address.
    const fallback = vi.fn(() => true);
    const refused = {
      writeText: vi.fn(async () => {
        throw new Error("NotAllowedError");
      }),
    };
    await expect(
      copyGuideLink(
        "/docs/b.pdf",
        "https://sunpride.cauldnclark.com",
        refused,
        fallback,
      ),
    ).resolves.toBe("https://sunpride.cauldnclark.com/docs/b.pdf");
    expect(fallback).toHaveBeenCalledWith(
      "https://sunpride.cauldnclark.com/docs/b.pdf",
    );
  });

  it("is in the sidebar for every signed-in role, and GuidesLink points at it", () => {
    for (const role of APP_ROLES) {
      expect(canAccessWebModule("guides", role)).toBe(true);
      const items = getWebNavigation("/guides", (slug) =>
        canAccessWebModule(slug, role),
      ).navGroups.flatMap((g) => g.items);
      expect(items.find((i) => i.id === "guides")?.href).toBe("/guides");
    }
    expect(primaryIdFor("/guides")).toBe("guides");
    expect(renderToStaticMarkup(createElement(GuidesLink, {}))).toContain(
      'href="/guides"',
    );
  });

  it("the stale static guide site is gone", () => {
    expect(existsSync(`${publicDir}/guides`)).toBe(false);
  });
});
