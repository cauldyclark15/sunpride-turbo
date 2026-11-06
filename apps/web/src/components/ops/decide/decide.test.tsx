import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "@/lib/api/provider";
import { ApiStore } from "@/lib/api/store";
import { DecideInbox, DecideInboxView } from "./decide-inbox";
import {
  ageText,
  decideBody,
  decideProblems,
  filterItems,
  verdictLabels,
  type DecideForm,
  type DecideInboxData,
  type DecideItem,
} from "./decide-model";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));

const NOW = Date.UTC(2026, 10, 6, 6, 0, 0);
const item = (o: Partial<DecideItem> = {}): DecideItem => ({
  id: "transfer_variance:t1",
  ref: "t1",
  kind: "transfer_variance",
  kindLabel: "Transfer difference",
  title: "Depot transfer: Cebu depot to Mandaue store was received with a difference",
  documentNumber: "TRF-CEB-261106-0012",
  askedBy: "Maria Santos",
  askedAt: NOW - 3 * 3600000,
  valueCentavos: 192000,
  rule: "A difference on a delivered document above ₱500.00 or 1 case needs a person to decide (standard setting).",
  link: "/operations/transfers/t1",
  canDecide: true,
  blockedReason: null,
  makerChecker:
    "The person who asked for this, counted it, sent it or received it cannot decide it. The system checks that for you.",
  lines: [{ label: "Received by", value: "Maria Santos" }],
  needs: { chargeTo: true },
  ...o,
});
const data = (items: DecideItem[]): DecideInboxData => ({
  asOf: NOW,
  total: items.length,
  counts: items.reduce<Record<string, number>>((m, i) => {
    m[i.kind] = (m[i.kind] ?? 0) + 1;
    return m;
  }, {}),
  kinds: {
    load_difference: "Load difference",
    transfer_variance: "Transfer difference",
    reload_difference: "Reload difference",
    load_in_difference: "Load-in difference",
    count_review: "Count review",
    disposition: "Bad order",
    cash_variance: "Cash difference",
    override_review: "Till override",
  },
  items,
  warnings: [],
  recent: [],
});
const form: DecideForm = { verdict: "approve", reason: "", chargeTo: "" };
const view = (d: DecideInboxData, extra: Partial<Parameters<typeof DecideInboxView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(DecideInboxView, {
      data: d,
      kind: null,
      onKind: () => {},
      openId: null,
      form,
      onOpen: () => {},
      onForm: () => {},
      onCancel: () => {},
      onSend: () => {},
      ...extra,
    }),
  );
const wrap = (node: ReactElement) =>
  renderToStaticMarkup(createElement(ApiProvider, { store: new ApiStore() }, node));

describe("Decide inbox rows", () => {
  it("says what, who asked, how much, how old, the rule that sent it here, and links to the document", () => {
    const html = view(data([item()]));
    expect(html).toContain("Transfer difference");
    expect(html).toContain("TRF-CEB-261106-0012");
    expect(html).toContain("Asked by");
    expect(html).toContain("Maria Santos");
    expect(html).toContain("₱1,920.00");
    expect(html).toContain("waiting 3 h");
    expect(html).toContain("Why it is here:");
    expect(html).toContain("needs a person to decide");
    expect(html).toContain('href="/operations/transfers/t1"');
    expect(html).toContain("Open the transfer");
    expect(html).toContain("Write it off");
    expect(html).toContain("Send back for a recount");
    expect(html).toContain("cannot decide it");
  });

  it("shows the maker-checker block in plain words and no decision buttons when the server would refuse", () => {
    const html = view(
      data([
        item({
          canDecide: false,
          blockedReason: "You sent or received this, so a different person must decide the difference.",
        }),
      ]),
    );
    expect(html).toContain("You sent or received this");
    expect(html).not.toContain("Write it off");
    expect(html).toContain("Open the transfer");
  });

  it("a row decided inside its own page offers only Open", () => {
    const html = view(
      data([
        item({
          id: "cash_variance:c1",
          kind: "cash_variance",
          kindLabel: "Cash difference",
          canDecide: false,
          openOnly: true,
          link: "/van-trips?tripId=x",
          needs: {},
        }),
      ]),
    );
    expect(html).toContain("Open the trip");
    expect(html).not.toContain(">Accept<");
  });

  it("an open row asks who carries the difference and, on reject, for a reason; the problem is said before sending", () => {
    const html = view(data([item()]), { openId: "transfer_variance:t1" });
    expect(html).toContain("Who carries the difference");
    expect(html).toContain("Sending side (the depot)");
    expect(html).toContain("Say who carries the difference");
    const rej = view(data([item()]), {
      openId: "transfer_variance:t1",
      form: { verdict: "reject", reason: "", chargeTo: "" },
    });
    expect(rej).toContain("Why are you rejecting this?");
    expect(rej).toContain("Say why you are rejecting this");
    expect(rej).not.toContain("Who carries the difference");
  });

  it("shows a sent-back item with who sent it back and why", () => {
    const html = view(
      data([item({ sentBack: { by: "Pat Approver", reason: "Count the pallet again", at: NOW } })]),
    );
    expect(html).toContain("Sent back");
    expect(html).toContain("Pat Approver");
    expect(html).toContain("Count the pallet again");
  });

  it("has chips with counts per kind and an all-clear message", () => {
    const two = data([
      item(),
      item({ id: "count_review:s1", kind: "count_review", kindLabel: "Count review", needs: {} }),
    ]);
    const html = view(two);
    expect(html).toContain("Everything 2");
    expect(html).toContain("Transfer difference 1");
    expect(html).toContain("Count review 1");
    expect(view(data([]))).toContain("Nothing is waiting for you.");
    expect(view(data([]))).toContain("All clear");
    expect(filterItems(two.items, "count_review")).toHaveLength(1);
  });

  it("says when a list could not be read, in words", () => {
    const d = { ...data([]), warnings: [{ kind: "load_difference", message: "This list could not be read just now." }] };
    expect(view(d)).toContain("Some lists could not be read just now.");
  });

  it("never shows a raw id or a technical word", () => {
    const html = view(data([item()]));
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });

  it("the container loads before it renders and shows no error state at first paint", () => {
    const html = wrap(createElement(DecideInbox));
    expect(html).toContain("Loading");
    expect(html).not.toContain("Something went wrong");
  });
});

describe("Decide model", () => {
  it("only sends what the server takes, with the key", () => {
    const i = item();
    expect(
      decideBody(i, { verdict: "approve", reason: " why ", chargeTo: "driver" }, "k1"),
    ).toEqual({ id: i.id, verdict: "approve", reason: "why", chargeTo: "driver", idempotencyKey: "k1" });
    expect(
      decideBody(i, { verdict: "reject", reason: "no", chargeTo: "driver" }, "k2"),
    ).toEqual({ id: i.id, verdict: "reject", reason: "no", idempotencyKey: "k2" });
    expect(decideProblems(i, { verdict: "approve", reason: "", chargeTo: "" })).toHaveLength(1);
    expect(decideProblems(i, { verdict: "approve", reason: "", chargeTo: "carrier" })).toEqual([]);
    expect(decideProblems(i, { verdict: "reject", reason: "ab", chargeTo: "" })).toHaveLength(1);
  });

  it("speaks the words of each kind and counts age in plain units", () => {
    expect(verdictLabels("cash_variance")).toEqual({ approve: "Accept the difference", reject: "Investigate" });
    expect(verdictLabels("cash_variance", true).approve).toBe("Accept the close");
    expect(verdictLabels("load_difference")).toEqual({ approve: "Approve", reject: "Reject" });
    expect(ageText(NOW - 30000, NOW)).toBe("just now");
    expect(ageText(NOW - 5 * 60000, NOW)).toBe("5 min");
    expect(ageText(NOW - 3 * 86400000, NOW)).toBe("3 days");
    expect(ageText(null, NOW)).toBe("—");
  });
});
