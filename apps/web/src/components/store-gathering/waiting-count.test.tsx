import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// WEB-040: the New stores badge counts everything the tab asks this user to act on, not only
// gathered field captures. An office-added store waits as a pin to confirm.
const perms = vi.hoisted(() => ({ list: new Set<string>() }));
const data = vi.hoisted(() => ({ byPath: {} as Record<string, unknown> }));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({ can: (p: string) => perms.list.has(p) }),
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown, path: string) => ({
    data: key ? data.byPath[path.split("?")[0] ?? ""] : undefined,
  }),
  apiFetch: vi.fn(),
  mutate: vi.fn(),
}));

import { useWaitingCount } from "./tab";

function Probe() {
  const n = useWaitingCount();
  return createElement("span", null, n === null ? "none" : String(n));
}
const render = () => renderToStaticMarkup(createElement(Probe));

describe("New stores waiting count", () => {
  beforeEach(() => {
    perms.list = new Set();
    data.byPath = {
      "/api/v1/masters/census-queue": { rows: [], truncated: false },
      "/api/v1/outlets/pins/queue": { page: [{ id: "pin-1" }] },
      "/api/v1/outlets/enrolment/pending": { page: [{ id: "e-1" }, { id: "e-2" }] },
    };
  });

  it("counts an office-added store waiting for its pin when no field capture waits", () => {
    perms.list = new Set(["outlet.verify"]);
    expect(render()).toContain(">1<");
  });

  it("adds new-store approvals for an approver", () => {
    perms.list = new Set(["outlet.verify", "outlet.enrol.approve"]);
    expect(render()).toContain(">3<");
  });

  it("adds captures, pins and approvals together", () => {
    perms.list = new Set(["outlet.verify", "outlet.enrol.approve"]);
    data.byPath["/api/v1/masters/census-queue"] = {
      rows: [{}, {}],
      truncated: false,
    };
    expect(render()).toContain(">5<");
  });

  it("shows no badge without a review permission", () => {
    expect(render()).toContain("none");
  });
});
