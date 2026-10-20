import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { actions, keys, permission } = vi.hoisted(() => ({
  actions: [] as (() => void)[],
  keys: [] as unknown[],
  permission: { read: true, manage: false },
}));
vi.mock("@heroui/react", () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
  }: {
    children: ReactNode;
    onPress?: () => void;
    isDisabled?: boolean;
  }) => {
    if (onPress) actions.push(onPress);
    return createElement("button", { disabled: isDisabled }, children);
  },
}));
vi.mock("@sunpride/ui", () => ({
  Card: ({ children, label }: { children: ReactNode; label: string }) =>
    createElement("section", null, label, children),
  FormField: ({ children, label }: { children: ReactNode; label: string }) =>
    createElement("label", null, label, children),
  WorkspaceIcon: () => null,
}));
vi.mock("../../lib/auth", () => ({
  usePermissions: () => ({
    can: (cap: string) =>
      cap === "integration.manage" ? permission.manage : permission.read,
  }),
}));
vi.mock("../../lib/api", () => ({
  useApi: (key: unknown) => {
    keys.push(key);
    return { data: undefined, error: undefined, refetch: vi.fn() };
  },
  useLive: vi.fn(),
  apiFetch: vi.fn(),
  mutate: vi.fn(),
}));
import {
  IntegrationQueue,
  IntegrationWorkspace,
  queueAge,
  type Queue,
} from "./integration-workspace";
const data: Queue = {
  asOf: 100000000,
  rows: [
    {
      id: "private-row-id",
      kind: "invoice",
      label: "Sample invoice 17",
      direction: "outbound",
      status: "dead_letter",
      attempts: 1,
      owner: null,
      openedAt: 99000000,
      error: "SAP rejection; operator action required",
      escalated: true,
      documentNumber: null,
    },
  ],
  next: null,
  counts: { failed: 1, stuck: 0, today: 6, prior: 4, oldest: 99000000 },
};
beforeEach(() => {
  actions.length = 0;
  keys.length = 0;
  permission.read = true;
  permission.manage = false;
});
describe("F-005 integration exception console", () => {
  it("F-005 shows failed posts, owner, age, target, prior period and next action without raw IDs", () => {
    const selected: string[] = [];
    const html = renderToStaticMarkup(
      <IntegrationQueue data={data} onSelect={(id) => selected.push(id)} />,
    );
    expect(html).toContain("Needs a decision");
    expect(html).toContain("Unassigned");
    expect(html).toContain("16 min");
    expect(html).toContain("Target: none");
    expect(html).toContain("4 in the previous 24 hours");
    expect(html).toContain("Escalated");
    expect(html).not.toContain("private-row-id");
    actions[0]!();
    expect(selected).toEqual(["private-row-id"]);
  });
  it("F-005 completed acknowledgement is distinct from an empty attention queue", () => {
    const done = {
      ...data,
      rows: [
        {
          ...data.rows[0]!,
          status: "completed",
          documentNumber: "SAMPLE-INVOICE-00000017",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <IntegrationQueue data={done} onSelect={() => {}} />,
    );
    expect(html).toContain("Accepted by SAP");
    expect(html).toContain("SAMPLE-INVOICE-00000017");
    expect(
      renderToStaticMarkup(
        <IntegrationQueue data={{ ...data, rows: [] }} onSelect={() => {}} />,
      ),
    ).toContain("No records in this queue");
  });
  it("F-005 unauthorized roles never start a queue, owner or trace request", () => {
    permission.read = false;
    renderToStaticMarkup(<IntegrationWorkspace />);
    expect(keys).toEqual([null, null, null, null, null]);
  });
  it("F-005 read-only operators do not fetch the owner editor", () => {
    renderToStaticMarkup(<IntegrationWorkspace />);
    expect(keys[0]).not.toBeNull();
    expect(keys[1]).toBeNull();
  });
  it("F-005 age labels have explicit minute/hour/day boundaries", () => {
    expect(queueAge(0, 59999)).toBe("0 min");
    expect(queueAge(0, 3600000)).toBe("1 hr");
    expect(queueAge(0, 86400000)).toBe("1 days");
    expect(queueAge(100, 0)).toBe("0 min");
  });
});
