import { describe, expect, it } from "vitest";
import { ANA, BEN, OUTLET_REF, RESTRICTED_REF } from "./fixtures";
import {
  activeTrigger,
  applyTrigger,
  bodyToDraft,
  parseBody,
  plainText,
  refTitle,
  refsInBody,
  serializeDraft,
  type NameLookup,
} from "./tokens";

const lookup: NameLookup = {
  user: (id) => ({ [ANA.id]: ANA.display_name, [BEN.id]: BEN.display_name })[id],
  ref: (type, id) =>
    [OUTLET_REF, RESTRICTED_REF].find((ref) => ref.type === type && ref.id === id),
};

describe("body tokens", () => {
  it("parses mentions, object tags, @channel and links in order", () => {
    const body = `Hi <@user:${ANA.id}>, see <#outlet:${OUTLET_REF.id}> <!channel> https://example.com/a.`;
    expect(parseBody(body)).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "user", id: ANA.id },
      { kind: "text", text: ", see " },
      { kind: "ref", type: "outlet", id: OUTLET_REF.id },
      { kind: "text", text: " " },
      { kind: "channel" },
      { kind: "text", text: " " },
      { kind: "link", url: "https://example.com/a" },
      { kind: "text", text: "." },
    ]);
  });

  it("never shows an unknown tag type raw", () => {
    const segments = parseBody("before <#spaceship:1> after");
    expect(segments).toEqual([{ kind: "text", text: "before  after" }]);
  });

  it("lists object tags for resolving", () => {
    expect(refsInBody(`<#product:p1> and <#order:o9>`)).toEqual([
      { type: "product", id: "p1" },
      { type: "order", id: "o9" },
    ]);
  });

  it("previews as plain text with names, never tokens", () => {
    const text = plainText(
      `<!channel> <@user:${BEN.id}> check <#order:${RESTRICTED_REF.id}>`,
      lookup,
    );
    expect(text).toBe("@channel @Ben Reyes check #Restricted item");
    expect(text).not.toMatch(/<[@#!]/);
  });

  it("restricted and missing refs never leak a title", () => {
    expect(refTitle({ ...OUTLET_REF, access: "restricted", title: "Secret" })).toBe(
      "Restricted item",
    );
    expect(refTitle({ ...OUTLET_REF, access: "missing" })).toBe("Removed item");
    expect(refTitle(undefined)).toBe("Item");
  });
});

describe("composer drafts", () => {
  it("turns picked labels and @channel into tokens on send", () => {
    const body = serializeDraft("@Ana Cruz look at #Puregold Cubao @channel ", [
      { label: "@Ana Cruz", token: `<@user:${ANA.id}>` },
      { label: "#Puregold Cubao", token: `<#outlet:${OUTLET_REF.id}>` },
    ]);
    expect(body).toBe(
      `<@user:${ANA.id}> look at <#outlet:${OUTLET_REF.id}> <!channel>`,
    );
  });

  it("round-trips a stored body through the editor", () => {
    const stored = `Ask <@user:${ANA.id}> about <#outlet:${OUTLET_REF.id}>`;
    const draft = bodyToDraft(stored, lookup);
    expect(draft.text).toBe("Ask @Ana Cruz about #Puregold Cubao");
    expect(serializeDraft(draft.text, draft.inserts)).toBe(stored);
  });

  it("finds the @ or # word at the caret", () => {
    expect(activeTrigger("hi @an", 6)).toEqual({ trigger: "@", query: "an", start: 3 });
    expect(activeTrigger("#pure", 5)).toEqual({ trigger: "#", query: "pure", start: 0 });
    expect(activeTrigger("mail@example", 12)).toBeNull();
    expect(activeTrigger("@ana done", 9)).toBeNull();
  });

  it("replaces the trigger word with the picked label", () => {
    expect(applyTrigger("hi @an!", 6, 3, "@Ana Cruz")).toEqual({
      text: "hi @Ana Cruz !",
      caret: 13,
    });
  });
});
