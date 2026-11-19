import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TesterGuide } from "../beta/tester-guide";
import { PRIVACY_CONTACT, PrivacyPolicy } from "./privacy-policy";

describe("privacy policy (SP-0208)", () => {
  const html = renderToStaticMarkup(createElement(PrivacyPolicy));

  it("covers the sections Google Play reviewers look for", () => {
    for (const heading of [
      "Who we are",
      "What we collect",
      "Who can see it",
      "How long we keep it",
      "How we protect it",
      "Children",
      "Changes",
    ])
      expect(html).toContain(heading);
    expect(html).toContain("Last updated");
    expect(html).toContain(`mailto:${PRIVACY_CONTACT}`);
    expect(html).toContain("Cauld &amp; Clark IT Solutions");
    expect(html).toContain("deleted automatically after 90 days");
    expect(html).toContain("under 18");
  });

  it("has a deletion anchor for /privacy#delete", () => {
    expect(html).toContain('id="delete"');
    expect(html).toContain("deactivate your account");
  });

  it("is linked from the help page", () => {
    expect(renderToStaticMarkup(createElement(TesterGuide))).toContain(
      'href="/privacy"',
    );
  });
});
