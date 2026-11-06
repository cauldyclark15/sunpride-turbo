import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deck = readFileSync(
  new URL("../../public/kickoff/index.html", import.meta.url),
  "utf8",
);
const slides = [...deck.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)].map(
  (match) =>
    match[1]!
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
);
const updates = slides.find((slide) =>
  slide.includes("When a new version is ready"),
);
const messages = slides.find((slide) =>
  slide.includes("We talk inside the app."),
);

describe("kickoff app-update instructions (SP-0157)", () => {
  it("announces updates in Messages with a Drive link, not an automatic System message", () => {
    expect(updates).toContain("We post it in Messages with the Drive link");
    expect(messages).toContain("App updates are announced here");
    expect(`${messages} ${updates}`).not.toContain('"System"');
    expect(updates).not.toContain("Update available");
  });

  it("tells users to install over the current app and keep saved work", () => {
    expect(updates).toContain(
      "Download it and install it over the current app. Your saved work stays.",
    );
  });

  it("locates the installed and latest version check under Account", () => {
    expect(updates).toContain(
      "Account → Check app updates shows your installed and latest versions",
    );
    expect(updates).not.toContain("Settings shows");
  });
});
