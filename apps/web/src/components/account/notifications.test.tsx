import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, it, expect, vi } from "vitest";
import { AccountNotifications, NotificationList } from "./notifications";
const state = vi.hoisted(() => ({
  denied: false,
  values: {} as Record<string, unknown>,
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown[] | null) => ({
    data: key ? state.values[String(key[0])] : undefined,
    error:
      state.denied && key ? new Error("Your access was removed") : undefined,
    refetch: vi.fn(),
  }),
  mutate: vi.fn(),
}));
const notice = {
  id: "hidden-notice",
  kind: "claim_escalation",
  title: "Sample claim follow-up",
  message: "Independent Finance review is needed.",
  read: false,
  href: "/finance-claims",
};
beforeEach(() => {
  state.denied = false;
  state.values = {
    "account-notices": {
      rows: [notice],
      mailMode: "dev_sink",
      limitNote: "Latest 100 company notices.",
    },
    "account-alerts": {
      rows: [
        {
          id: "hidden-alert",
          title: "Shelf availability below threshold",
          read: false,
        },
      ],
    },
  };
});
it("gives a recipient an actionable combined inbox and labels the free local sink honestly", () => {
  const html = renderToStaticMarkup(
    createElement(AccountNotifications, { partner: false, readAlerts: true }),
  );
  expect(html).toContain("Sample claim follow-up");
  expect(html).toContain("Shelf availability below threshold");
  expect(html).toContain("unread in this view");
  expect(html).toContain("/finance-claims");
  expect(html).toContain("/decide");
  expect(html).toContain("no external email is sent");
  expect(html).toContain("Mark read");
  expect(html).not.toContain("hidden-notice");
});
it("shows read state without leaking identifiers or offering another read action", () => {
  const html = renderToStaticMarkup(
    createElement(NotificationList, {
      rows: [{ ...notice, read: true }],
      onRead: vi.fn(),
    }),
  );
  expect(html).toContain("Read");
  expect(html).not.toContain("Mark read");
  expect(html).not.toContain("hidden-notice");
});
it("an access refusal hides retained case names, alerts and actions", () => {
  state.denied = true;
  const html = renderToStaticMarkup(
    createElement(AccountNotifications, { partner: false, readAlerts: true }),
  );
  expect(html).toContain("Your access was removed");
  expect(html).not.toContain("Sample claim follow-up");
  expect(html).not.toContain("Shelf availability below threshold");
  expect(html).not.toContain("Mark read");
});
