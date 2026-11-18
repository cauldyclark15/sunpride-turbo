import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FIELD_APP_LINKS } from "../../config/app-links";
import {
  AppLinkRow,
  CopyLinkButton,
  ShareFieldAppCard,
  copyText,
} from "./app-links";

const [play, drive] = FIELD_APP_LINKS;

describe("Field app links", () => {
  it("uses the fixed Play link and the Drive folder (not a file)", () => {
    expect(play.url).toBe(
      "https://play.google.com/apps/internaltest/4701513704454726563",
    );
    expect(drive.url).toBe(
      "https://drive.google.com/drive/folders/181uAAjyMxw08WoDKSGaumrTPPZvQA282",
    );
  });

  it("renders both rows with label, full-URL tooltip, safe Open link and Copy button", () => {
    const html = renderToStaticMarkup(createElement(ShareFieldAppCard));
    expect(html).toContain("Share the Field app");
    for (const link of FIELD_APP_LINKS) {
      expect(html).toContain(link.label);
      expect(html).toContain(`title="${link.url}"`);
      expect(html).toContain(`aria-label="Copy ${link.name} link"`);
    }
    expect(html.match(/target="_blank" rel="noopener noreferrer"/g)?.length).toBe(4);
    const text = html.replace(/<[^>]*>/g, " ").replace(/https:\/\/\S+/g, " ");
    expect(text).not.toMatch(/\bVan\b/i);
    expect(text).not.toMatch(/\bapps\b/i);
  });

  it("shows Copied with a check icon, and the fallback message on failure", () => {
    const copied = renderToStaticMarkup(
      createElement(CopyLinkButton, { link: play, status: "copied", onCopy: () => {} }),
    );
    expect(copied).toContain("Copied");
    expect(copied).toContain('data-icon="check"');
    const failed = renderToStaticMarkup(
      createElement(AppLinkRow, { link: drive, status: "failed" }),
    );
    expect(failed).toContain("copy, select the link instead");
  });
});

describe("copyText", () => {
  it("copies the exact URL with the Clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyText(play.url, { clipboard: { writeText }, document: null })).toBe(true);
    expect(writeText).toHaveBeenCalledWith(play.url);
  });

  function fakeDocument(result: boolean) {
    const area = { value: "", style: {}, setAttribute: vi.fn(), select: vi.fn() };
    const doc = {
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      createElement: vi.fn(() => area),
      execCommand: vi.fn(() => result),
    };
    return { area, doc: doc as unknown as Document };
  }

  it("falls back to a hidden textarea when the Clipboard API rejects or is missing", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("insecure"));
    const { area, doc } = fakeDocument(true);
    expect(await copyText(drive.url, { clipboard: { writeText }, document: doc })).toBe(true);
    expect(area.value).toBe(drive.url);
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    expect(doc.body.removeChild).toHaveBeenCalled();
    const missing = fakeDocument(true);
    expect(await copyText(play.url, { clipboard: null, document: missing.doc })).toBe(true);
    expect(missing.area.value).toBe(play.url);
  });

  it("reports failure when both ways fail", async () => {
    const { doc } = fakeDocument(false);
    expect(await copyText(play.url, { clipboard: null, document: doc })).toBe(false);
    expect(await copyText(play.url, { clipboard: null, document: null })).toBe(false);
  });
});
