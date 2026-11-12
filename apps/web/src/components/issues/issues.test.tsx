import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssuesPage } from "./issues-page";
import { IssuesBoard } from "./issues-board";
import { IssuesList } from "./issues-list";
import { IssueCreatePage } from "./issue-create-page";
import { IssueActivity, IssueDetailPage } from "./issue-detail-page";
import { AttachmentRenderer } from "./attachment-renderer";
import { selectedFileError, uploadIssueFiles } from "./attachment-picker";
import { ISSUE_STATUSES } from "../../lib/issues";
import type { IssueCard, IssueDetail } from "./issue-access";
const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  liveCalls: [] as { topics: unknown; keys: unknown }[],
  readError: "",
  requestKeys: [] as (string | undefined)[],
  queryCalls: [] as { name: string; args: unknown }[],
  mutations: [] as { name: string; args: unknown }[],
  buttons: [] as { label: string; onPress?: () => void }[],
  elements: [] as { type: string; props: Record<string, unknown> }[],
  pushes: [] as string[],
  tab: "discussion",
  filters: {} as Record<string, unknown>,
  fields: {} as Record<string, unknown>,
  reject: "",
  page: 1,
  inputText: "",
  editing: false,
  booleanHook: 0,
  editingComment: false,
  commentBody: "",
  files: [] as File[],
}));
vi.mock("../../lib/api", async (original) => {
  const actual = await original<typeof import("../../lib/api")>();
  const command = async (name: string, args: unknown) => {
    state.mutations.push({ name, args });
    if (name === state.reject) throw new Error("Rejected");
    if (name.endsWith("/uploads/claim"))
      return {
        uploadId: "storage-1",
        uploadToken: "spu_test",
        uploadUrl: "https://upload.example.com",
        chunkUrl: "/chunks",
        chunkBytes: 8 * 1024 * 1024,
        expiresAt: Date.now() + 10000,
      };
    if (name.endsWith("/create"))
      return { issueId: "issue-1", number: 42, key: "SP-0042" };
    return {};
  };
  return {
    ...actual,
    useApi: (key: unknown[] | null) => {
      const name = key ? `/api/v1/issues/${key[1]}` : "skipped";
      state.queryCalls.push({ name, args: key ? key[2] : null });
      return {
        data: key ? state.values[name] : undefined,
        error:
          state.readError === name
            ? new actual.ApiError({
                code: "network_error",
                message: "Connection lost",
              })
            : null,
      };
    },
    useLive: (topics: unknown, keys: unknown) => {
      state.liveCalls.push({ topics, keys });
    },
    mutate: (
      name: string,
      args: unknown,
      options: { idempotencyKey?: string },
    ) => {
      state.requestKeys.push(options.idempotencyKey);
      return command(name, args);
    },
    apiFetch: (name: string, options: { body: unknown }) =>
      command(name, options.body),
  };
});
vi.mock("../../lib/auth", () => ({
  useSession: () => {
    const profile = state.values["/api/me"] as
      { status: string; role: string } | null | undefined;
    return {
      profile: profile
        ? { ...profile, active: profile.status === "active" }
        : null,
      status: profile === undefined ? "loading" : "authenticated",
    };
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => state.pushes.push(href) }),
  useSearchParams: () => new URLSearchParams(`tab=${state.tab}`),
  usePathname: () => "/issues",
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      let value =
        typeof initial === "function" ? (initial as () => unknown)() : initial;
      if (value === "discussion") value = state.tab;
      if (value === 1) value = state.page;
      if (value === false) {
        state.booleanHook++;
        if (state.editing && state.booleanHook === 1) value = true;
        if (state.editingComment && state.booleanHook === 3) value = true;
      }
      if (value === "" && state.inputText) value = state.inputText;
      if (value === "Confirmed in QA" && state.commentBody)
        value = state.commentBody;
      if (Array.isArray(value) && value.length === 0 && state.files.length)
        value = state.files;
      if (value && typeof value === "object" && "archived" in value)
        value = { ...value, ...state.filters };
      if (value && typeof value === "object" && "title" in value)
        value = { ...value, ...state.fields };
      return [value, vi.fn()];
    },
  };
});
vi.mock("react/jsx-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-runtime")>();
  const capture =
    (fn: typeof actual.jsx) =>
    (type: React.ElementType, props: Record<string, unknown>, key: string) => {
      if (
        ["form", "select", "input", "textarea", "article", "section"].includes(
          String(type),
        )
      )
        state.elements.push({ type: String(type), props });
      return fn(type, props, key);
    };
  return { ...actual, jsx: capture(actual.jsx), jsxs: capture(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const actual = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      const [type, props] = args;
      if (
        ["form", "select", "input", "textarea", "article", "section"].includes(
          String(type),
        )
      ) {
        state.elements.push({
          type: String(type),
          props: props as Record<string, unknown>,
        });
      }
      return actual.jsxDEV(...args);
    },
  };
});
vi.mock("@heroui/react", () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
    isPending,
    isIconOnly,
    variant,
    ...props
  }: {
    children: React.ReactNode;
    onPress?: () => void;
    isDisabled?: boolean;
    isPending?: boolean;
    isIconOnly?: boolean;
    variant?: string;
    [key: string]: unknown;
  }) => {
    void isIconOnly;
    void variant;
    const label = String(
      props["aria-label"] ??
        React.Children.toArray(children)
          .filter((child) => typeof child === "string")
          .join("")
          .trim(),
    );
    state.buttons.push({ label, onPress });
    return createElement(
      "button",
      { ...props, disabled: isDisabled || isPending },
      children,
    );
  },
}));
vi.mock("@sunpride/ui", () => ({
  WorkspaceIcon: ({ name }: { name: string }) =>
    createElement("span", { "data-icon": name }),
  PageHeader: ({
    title,
    meta,
    actions,
  }: {
    title: string;
    meta?: React.ReactNode;
    actions?: React.ReactNode;
  }) =>
    createElement(
      "header",
      null,
      createElement("h1", null, title),
      meta,
      actions,
    ),
  Card: ({ label, children }: { label: string; children: React.ReactNode }) =>
    createElement(
      "section",
      { "aria-label": label },
      createElement("h2", null, label),
      children,
    ),
  FormField: ({
    label,
    children,
    hint,
  }: {
    label: string;
    children: React.ReactNode;
    hint?: string;
  }) => createElement("label", null, label, children, hint),
  StatusPill: ({ children }: { children: React.ReactNode }) =>
    createElement(
      "span",
      null,
      typeof children === "string"
        ? children.charAt(0).toUpperCase() + children.slice(1)
        : children,
    ),
  EmptyPanel: ({ title }: { title: string }) => createElement("p", null, title),
  Notice: ({ title, meta }: { title: string; meta?: string }) =>
    createElement("aside", null, title, meta),
  Pager: ({
    page,
    canPrevious,
    canNext,
  }: {
    page: number;
    canPrevious: boolean;
    canNext: boolean;
  }) =>
    canPrevious || canNext
      ? createElement(
          "nav",
          { "aria-label": "Issue pages" },
          "Previous",
          `Page ${page}`,
          "Next",
        )
      : null,
  UnderlineTabs: ({
    items,
    activeId,
  }: {
    items: readonly (readonly [string, string])[];
    activeId: string;
  }) =>
    createElement(
      "nav",
      null,
      items.map(([id, label]) =>
        createElement(
          "button",
          { key: id, "aria-current": id === activeId ? "page" : undefined },
          label,
        ),
      ),
    ),
}));
const id = (value: string) => value;
const timestamp = Date.UTC(2026, 9, 2, 12);
const card: IssueCard = {
  _id: id("issue-1"),
  number: 1,
  key: "SP-0001",
  title: "Order total is incorrect",
  area: "Orders",
  priority: "high",
  status: "draft",
  order: 1024,
  milestone: undefined,
  externalRef: undefined,
  assigneeId: undefined,
  reporterId: undefined,
  reporterName: "Ana",
  assigneeName: "Ben",
  commentCount: 2,
  attachmentCount: 3,
  lastCommentAt: timestamp,
  lastCommentAuthorName: "Ben",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const attachments: IssueDetail["comments"][number]["attachments"] = [
  {
    _id: id("image"),
    fileName: "evidence.png",
    fileType: "image/png",
    fileSize: 2048,
    kind: "image",
    url: "https://example.com/evidence.png",
  },
  {
    _id: id("video"),
    fileName: "recording.mp4",
    fileType: "video/mp4",
    fileSize: 4096,
    kind: "video",
    url: "https://example.com/recording.mp4",
  },
  {
    _id: id("document"),
    fileName: "steps.pdf",
    fileType: "application/pdf",
    fileSize: 1024,
    kind: "document",
    url: "https://example.com/steps.pdf",
  },
];
const detail: IssueDetail = {
  issue: {
    _id: card._id,
    number: 1,
    title: card.title,
    description: "Incorrect total after checkout",
    steps: "Open an order",
    actual: "Total doubles",
    expected: "Total matches lines",
    area: "Orders",
    priority: "high",
    status: "draft",
    order: 1024,
    archived: false,
    milestone: "Launch",
    externalRef: "SOP-004",
    assigneeId: id("ben"),
    reporterId: id("ana"),
    commentCount: 1,
    attachmentCount: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  key: "SP-0001",
  reporterName: "Ana",
  assigneeName: "Ben",
  comments: [
    {
      _id: id("comment-1"),
      authorName: "Ben",
      authorId: undefined,
      updatedAt: undefined,
      body: "Confirmed in QA",
      createdAt: timestamp,
      canEdit: true,
      canDelete: true,
      attachments,
    },
  ],
  activity: [
    {
      _id: id("event-1"),
      kind: "status_changed",
      actorName: "Ben",
      fromStatus: "draft",
      toStatus: "ongoing_test",
      changes: undefined,
      note: undefined,
      createdAt: timestamp,
    },
    {
      _id: id("event-2"),
      kind: "updated",
      actorName: "Ana",
      fromStatus: undefined,
      toStatus: undefined,
      note: undefined,
      changes: [{ field: "priority", from: "medium", to: "high" }],
      createdAt: timestamp,
    },
  ],
};
const counts = Object.fromEntries(
  ISSUE_STATUSES.map((status) => [status, status === "draft" ? 1 : 0]),
) as Record<(typeof ISSUE_STATUSES)[number], number>;
function render(node: React.ReactNode) {
  return renderToStaticMarkup(node);
}
beforeEach(() => {
  state.values = {
    "/api/me": { status: "active", role: "admin" },
    "/api/v1/issues/access": {
      canRead: true,
      canWrite: true,
      canTriage: true,
      canManage: true,
      maxVideoBytes: 75 * 1024 * 1024,
    },
    "/api/v1/issues/board": {
      issues: [card],
      counts,
      milestones: ["Launch"],
      truncated: false,
    },
    "/api/v1/issues/assignees": [{ _id: "ben", name: "Ben", role: "admin" }],
    "/api/v1/issues/detail": detail,
  };
  state.queryCalls = [];
  state.liveCalls = [];
  state.readError = "";
  state.requestKeys = [];
  state.mutations = [];
  state.buttons = [];
  state.elements = [];
  state.pushes = [];
  state.tab = "discussion";
  state.filters = {};
  state.fields = {};
  state.reject = "";
  state.page = 1;
  state.inputText = "";
  state.editing = false;
  state.booleanHook = 0;
  state.editingComment = false;
  state.commentBody = "";
  state.files = [];
  vi.unstubAllGlobals();
});
describe("issue board and list", () => {
  it("renders all seven columns, counts, empty states and card metadata", () => {
    const html = render(
      <IssuesBoard issues={[card]} counts={counts} canWrite onMove={vi.fn()} />,
    );
    expect((html.match(/ column"/g) ?? []).length).toBe(7);
    expect((html.match(/No issues/g) ?? []).length).toBe(6);
    for (const text of [
      "Backlog",
      "Awaiting client response",
      "Ready for retest",
      "Done",
      "SP-0001",
      card.title,
      "Reporter: Ana",
      "Latest comment: Ben",
      "2 comments",
      "3 attachments",
      "2026",
    ])
      expect(html).toContain(text);
    expect(html).toContain('href="/issues/1"');
    expect(html).toContain('draggable="true"');
  });
  it("sorts cards by order and disables dragging for readers", () => {
    const html = render(
      <IssuesBoard
        issues={[
          {
            ...card,
            _id: id("issue-2"),
            title: "Second",
            order: 2048,
          },
          card,
        ]}
        counts={counts}
        canWrite={false}
        onMove={vi.fn()}
      />,
    );
    expect(html.indexOf(card.title)).toBeLessThan(html.indexOf("Second"));
    expect(html).not.toContain('draggable="true"');
  });
  it("renders 25 rows and the shared Pager", () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({
      ...card,
      _id: id(`issue-${index}`),
      title: `Row ${index}`,
      number: index + 1,
    }));
    const html = render(<IssuesList issues={rows} />);
    expect((html.match(/<tr/g) ?? []).length).toBe(26);
    expect(html).toContain("Row 24");
    expect(html).not.toContain("Row 25");
    expect(html).toContain("Issue pages");
    expect(html).toContain("Page 1");
  });
  it("renders an empty list and omits unnecessary pagination", () => {
    const html = render(<IssuesList issues={[]} />);
    expect(html).toContain("No issues match these filters");
    expect(html).not.toContain("Issue pages");
  });
  it("renders filters, summary and the create action", () => {
    const html = render(<IssuesPage />);
    for (const label of [
      "Search number or text",
      "All areas",
      "All statuses",
      "All priorities",
      "All assignees",
      "All milestones",
      "Unassigned",
      "Reset filters",
      "1 issues · 0 done · 1 open",
      "New issue",
    ])
      expect(html).toContain(label);
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
  });
  it("passes explicit filters and uses list for archived issues", () => {
    state.filters = {
      archived: true,
      status: "draft",
      priority: "high",
      area: "Orders",
      assignee: "unassigned",
      milestone: "Launch",
      search: "total",
    };
    const html = render(<IssuesPage />);
    expect(html).toContain("Issue list");
    expect(html).not.toContain("Issue board");
    expect(
      state.queryCalls.find((call) => call.name === "/api/v1/issues/board")
        ?.args,
    ).toEqual({
      archived: true,
      search: "total",
      area: "Orders",
      status: "draft",
      priority: "high",
      assigneeId: "unassigned",
      milestone: "Launch",
    });
  });
  it("notices truncated results and hides the create action for readers", () => {
    state.values["/api/v1/issues/board"] = {
      issues: [card],
      counts,
      milestones: [],
      truncated: true,
    };
    state.values["/api/v1/issues/access"] = {
      canRead: true,
      canWrite: false,
      canManage: false,
      maxVideoBytes: 1,
    };
    const html = render(<IssuesPage />);
    expect(html).toContain("Showing up to 500 issues");
    expect(html).not.toContain("New issue");
  });
});
describe("create issue", () => {
  it("renders CMS sections, required title, Backlog and sticky footer", () => {
    const html = render(<IssueCreatePage />);
    for (const text of [
      "Issue summary",
      "Title *",
      "required",
      "Description",
      "Reproduction and verification",
      "Steps to reproduce",
      "Actual behavior",
      "Expected behavior",
      "Attachments",
      "Issue settings",
      "Area (optional)",
      "Reference",
      "Milestone",
      "New issue · Backlog",
      "Starting status",
      "Fields marked with * are required.",
      "sticky bottom-0",
      "Cancel",
      "Save",
    ])
      expect(html).toContain(text);
    // WEB-161: forms say Save, never "Create …"
    expect(html).not.toMatch(/>\s*Create issue\s*</);
  });
  it("creates in the default area then navigates to the issue number", async () => {
    state.fields = {
      title: "  Checkout total  ",
      description: "Details",
      externalRef: "SOP-004",
      milestone: "Launch",
    };
    render(<IssueCreatePage />);
    const form = state.elements.find((element) => element.type === "form")!;
    await (form.props.onSubmit as (event: unknown) => Promise<void>)({
      preventDefault: vi.fn(),
    });
    expect(
      state.mutations.find((call) => call.name === "/api/v1/issues/create")
        ?.args,
    ).toMatchObject({
      title: "Checkout total",
      area: "Others",
      priority: "medium",
      description: "Details",
      externalRef: "SOP-004",
      milestone: "Launch",
      uploads: [],
    });
    expect(state.pushes).toEqual(["/issues/42"]);
  });
  it("prefills the reporting page and hides the assignee for testers", async () => {
    state.values["/api/v1/issues/access"] = {
      canRead: true,
      canWrite: true,
      canTriage: false,
      canManage: false,
      maxVideoBytes: 75 * 1024 * 1024,
    };
    const html = render(<IssueCreatePage from="/inventory" />);
    expect(html).toContain("Page: /inventory");
    expect(html).not.toContain(">Assignee<");
    expect(html).not.toContain("Unassigned");
    state.fields = { title: "Stock looks wrong", assignee: "ben" };
    render(<IssueCreatePage from="/inventory" />);
    await (
      state.elements.filter((element) => element.type === "form").at(-1)!.props
        .onSubmit as (event: unknown) => Promise<void>
    )({ preventDefault: vi.fn() });
    const args = state.mutations.find(
      (call) => call.name === "/api/v1/issues/create",
    )?.args as Record<string, unknown>;
    expect(args.title).toBe("Stock looks wrong");
    expect(args.assigneeId).toBeUndefined();
    expect(String(args.description)).toContain("Page: /inventory");
  });
  it("ignores an outside link as the reporting page", () => {
    const html = render(<IssueCreatePage from="https://evil.example" />);
    expect(html).not.toContain("evil.example");
  });
  it("does not navigate on mutation failure", async () => {
    state.fields = { title: "Checkout" };
    state.reject = "/api/v1/issues/create";
    render(<IssueCreatePage />);
    await (
      state.elements.find((element) => element.type === "form")!.props
        .onSubmit as (event: unknown) => Promise<void>
    )({ preventDefault: vi.fn() });
    expect(state.pushes).toEqual([]);
  });
});
describe("issue detail", () => {
  it("renders identity, title, provenance, discussion, attachment kinds and settings", () => {
    const html = render(<IssueDetailPage number="1" />);
    for (const text of [
      "SP-0001",
      "Orders",
      "Launch",
      "SOP-004",
      card.title,
      "Reported by Ana",
      "updated",
      "2026",
      "Issue details",
      "Discussion (1)",
      "Confirmed in QA",
      "evidence.png",
      "recording.mp4",
      "steps.pdf",
      "Issue status",
      "Issue assignee",
      "Edit issue",
      "Archive issue",
    ])
      expect(html).toContain(text);
    expect(html).toContain("<video");
    expect(html).toContain("<img");
    expect(html).toContain("Remove evidence.png");
  });
  it("renders human activity sentences in the Activity tab", () => {
    state.tab = "activity";
    const html = render(<IssueDetailPage number="1" />);
    expect(html).toContain("moved the issue from Backlog to In QA");
    expect(html).toContain("changed priority from medium to high");
    expect(html).not.toContain("Confirmed in QA");
  });
  it("shows an empty activity feed", () =>
    expect(render(<IssueActivity activity={[]} />)).toContain(
      "No activity yet",
    ));
  it("hides mutation controls, composer and attachment removal without write access", () => {
    state.values["/api/v1/issues/access"] = {
      canRead: true,
      canWrite: false,
      canManage: false,
      maxVideoBytes: 1,
    };
    const html = render(<IssueDetailPage number="1" />);
    for (const text of [
      "Issue status",
      "Issue area",
      "Issue priority",
      "Issue assignee",
      "Edit issue",
      "Archive issue",
      "Add a comment",
      "Delete comment",
      "Remove evidence.png",
    ])
      expect(html).not.toContain(text);
    expect(html).toContain("Confirmed in QA");
    expect(html).toContain("Backlog");
  });
  it("lets a beta tester comment and attach but not triage", () => {
    state.values["/api/me"] = {
      status: "active",
      role: "sales",
    };
    state.values["/api/v1/issues/access"] = {
      canRead: true,
      canWrite: true,
      canTriage: false,
      canManage: false,
      maxVideoBytes: 75 * 1024 * 1024,
    };
    const html = render(<IssueDetailPage number="1" />);
    expect(html).toContain("Add a comment");
    expect(html).toContain("Comment");
    for (const text of [
      "Issue status",
      "Issue area",
      "Issue priority",
      "Issue assignee",
      "Edit issue",
      "Archive issue",
    ])
      expect(html).not.toContain(text);
    expect(html).toContain("Backlog");
  });
  it("makes archived issues read-only and offers Restore to managers", () => {
    state.values["/api/v1/issues/detail"] = {
      ...detail,
      issue: { ...detail.issue, archived: true },
    };
    const html = render(<IssueDetailPage number="1" />);
    expect(html).toContain("Restore issue");
    expect(html).not.toContain("Issue status");
    expect(html).not.toContain("Add a comment");
  });
  it("renders the not-found and loading states", () => {
    state.values["/api/v1/issues/detail"] = null;
    expect(render(<IssueDetailPage number="bad" />)).toContain(
      "Issue not found",
    );
    state.values["/api/v1/issues/detail"] = undefined;
    expect(render(<IssueDetailPage number="1" />)).toContain("Loading issue");
  });
  it("updates status, area, priority and clears the assignee using the correct contracts", async () => {
    render(<IssueDetailPage number="1" />);
    for (const [label, value] of [
      ["Issue status", "ongoing_test"],
      ["Issue area", "Home"],
      ["Issue priority", "critical"],
      ["Issue assignee", ""],
    ]) {
      const control = state.elements.find(
        (element) => element.props["aria-label"] === label,
      )!;
      await (control.props.onChange as (event: unknown) => Promise<void>)({
        target: { value },
      });
      await flush();
    }
    expect(state.mutations).toEqual([
      {
        name: "/api/v1/issues/move",
        args: { issueId: "issue-1", status: "ongoing_test" },
      },
      {
        name: "/api/v1/issues/update",
        args: { issueId: "issue-1", area: "Home" },
      },
      {
        name: "/api/v1/issues/update",
        args: { issueId: "issue-1", priority: "critical" },
      },
      {
        name: "/api/v1/issues/update",
        args: { issueId: "issue-1", assigneeId: null },
      },
    ]);
  });
  it("renders unavailable attachment metadata without a broken link", () => {
    const html = render(
      <AttachmentRenderer attachments={[{ ...attachments[0]!, url: null }]} />,
    );
    expect(html).toContain("File unavailable");
    expect(html).not.toContain("href=");
  });
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
function event(value: string) {
  return { preventDefault: vi.fn(), target: { value } };
}
describe("interaction contracts", () => {
  function button(label: string) {
    return state.buttons.find((item) => item.label === label)!;
  }
  it("paginates to the remaining rows", () => {
    state.page = 2;
    const rows = Array.from({ length: 26 }, (_, index) => ({
      ...card,
      _id: id(`issue-${index}`),
      title: `Row ${index}`,
    }));
    const html = render(<IssuesList issues={rows} />);
    expect(html).toContain("Row 25");
    expect(html).not.toContain("Row 24");
    expect(html).toContain("Page 2");
  });
  it("moves between columns and sends above/below anchors", async () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    const destination = {
      ...card,
      _id: id("destination"),
      status: "ongoing_test" as const,
    };
    render(
      <IssuesBoard
        issues={[card, destination]}
        counts={counts}
        canWrite
        onMove={onMove}
      />,
    );
    const articles = state.elements.filter(
      (element) => element.type === "article",
    );
    (articles[0]!.props.onDragStart as (event: unknown) => void)({
      dataTransfer: { setData: vi.fn(), effectAllowed: "" },
    });
    await (articles[1]!.props.onDrop as (event: unknown) => Promise<void>)({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) },
      clientY: 10,
    });
    expect(onMove).toHaveBeenCalledWith({
      issueId: "issue-1",
      status: "ongoing_test",
      beforeId: undefined,
      afterId: "destination",
    });
  });
  it("archives, deletes comments and removes attachments only after confirmation", async () => {
    const confirm = vi.fn().mockReturnValue(true);
    vi.stubGlobal("window", { confirm });
    render(<IssueDetailPage number="1" />);
    for (const label of [
      "Archive issue",
      "Delete comment by Ben",
      "Remove evidence.png",
    ]) {
      button(label).onPress!();
      await flush();
    }
    expect(state.mutations).toEqual([
      { name: "/api/v1/issues/archive", args: { issueId: "issue-1" } },
      {
        name: "/api/v1/issues/deleteComment",
        args: { commentId: "comment-1" },
      },
      {
        name: "/api/v1/issues/removeAttachment",
        args: { attachmentId: "image" },
      },
    ]);
    expect(confirm).toHaveBeenCalledTimes(3);
  });
  it("does not archive when confirmation is cancelled", () => {
    vi.stubGlobal("window", { confirm: () => false });
    render(<IssueDetailPage number="1" />);
    button("Archive issue").onPress!();
    expect(state.mutations).toEqual([]);
  });
  it("restores archived issues", async () => {
    vi.stubGlobal("window", { confirm: () => true });
    state.values["/api/v1/issues/detail"] = {
      ...detail,
      issue: { ...detail.issue, archived: true },
    };
    render(<IssueDetailPage number="1" />);
    button("Restore issue").onPress!();
    await flush();
    expect(state.mutations).toEqual([
      { name: "/api/v1/issues/restore", args: { issueId: "issue-1" } },
    ]);
  });
  it("posts a comment with the issue ID", async () => {
    state.inputText = "Retested successfully";
    render(<IssueDetailPage number="1" />);
    const form = state.elements.find((element) => element.type === "form")!;
    (form.props.onSubmit as (event: unknown) => void)(event(""));
    await flush();
    expect(state.mutations).toEqual([
      {
        name: "/api/v1/issues/addComment",
        args: {
          issueId: "issue-1",
          body: "Retested successfully",
          uploads: [],
        },
      },
    ]);
  });
  it("edits a comment by its comment ID", async () => {
    state.editingComment = true;
    state.commentBody = "Retest passed";
    const html = render(<IssueDetailPage number="1" />);
    expect(html).toContain("Save comment");
    const form = state.elements
      .filter((element) => element.type === "form")
      .at(-1)!;
    (form.props.onSubmit as (event: unknown) => void)(event(""));
    await flush();
    expect(state.mutations).toEqual([
      {
        name: "/api/v1/issues/updateComment",
        args: { commentId: "comment-1", body: "Retest passed" },
      },
    ]);
  });
  it("uploads evidence before creating the issue", async () => {
    state.fields = { title: "Evidence issue" };
    state.files = [
      new File(["evidence"], "evidence.png", { type: "image/png" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ blobId: "storage-1", status: "stored" }),
      }),
    );
    render(<IssueCreatePage />);
    const form = state.elements.find((element) => element.type === "form")!;
    await (form.props.onSubmit as (event: unknown) => Promise<void>)(event(""));
    expect(state.mutations.map((call) => call.name)).toEqual([
      "/api/v1/issues/uploads/claim",
      "/api/v1/issues/create",
    ]);
    expect(state.mutations[1]!.args).toMatchObject({
      uploads: [{ storageId: "storage-1", fileName: "evidence.png" }],
    });
    expect(state.pushes).toEqual(["/issues/42"]);
  });
  it("saves title, reproduction fields and nullable references inline", async () => {
    state.editing = true;
    state.fields = {
      title: "Fixed title",
      description: "",
      steps: "New steps",
      actual: "New actual",
      expected: "New expected",
      externalRef: "",
      milestone: "",
    };
    const html = render(<IssueDetailPage number="1" />);
    expect(html).toContain("Save issue");
    const form = state.elements.find((element) => element.type === "form")!;
    (form.props.onSubmit as (event: unknown) => void)(event(""));
    await flush();
    expect(state.mutations).toEqual([
      {
        name: "/api/v1/issues/update",
        args: {
          issueId: "issue-1",
          title: "Fixed title",
          description: null,
          steps: "New steps",
          actual: "New actual",
          expected: "New expected",
          externalRef: null,
          milestone: null,
        },
      },
    ]);
  });
});
describe("access boundaries", () => {
  it.each([IssuesPage, IssueCreatePage, () => <IssueDetailPage number="1" />])(
    "skips issue queries for disallowed roles",
    (Component) => {
      // Beta: every app role reads issues; an unknown role still gets nothing.
      state.values["/api/me"] = {
        role: "contractor",
        status: "active",
      };
      const html = render(<Component />);
      expect(html).toContain("No access");
      expect(state.queryCalls.every((call) => call.args === null)).toBe(true);
    },
  );
  it("skips data queries when backend denies read access", () => {
    state.values["/api/v1/issues/access"] = {
      canRead: false,
      canWrite: false,
      canManage: false,
      maxVideoBytes: 1,
    };
    expect(render(<IssuesPage />)).toContain("No access");
    expect(
      state.queryCalls.find((call) => call.name === "/api/v1/issues/board")
        ?.args,
    ).toBeUndefined();
  });
  it("skips issue queries for inactive profiles", () => {
    state.values["/api/me"] = {
      role: "admin",
      status: "inactive",
    };
    expect(render(<IssuesPage />)).toContain("No access");
    expect(state.queryCalls.every((call) => call.args === null)).toBe(true);
  });
  it("denies create for read-only accounts", () => {
    state.values["/api/v1/issues/access"] = {
      canRead: true,
      canWrite: false,
      canManage: false,
      maxVideoBytes: 1,
    };
    expect(render(<IssueCreatePage />)).toContain("No access");
  });
});
describe("v2 issue data flow", () => {
  it("subscribes the board and selected issue to invalidations of every issue cache", () => {
    render(<IssuesPage />);
    expect(state.liveCalls).toContainEqual({
      topics: ["issues"],
      keys: [["issues"]],
    });
    render(<IssueDetailPage number="SP-0001" />);
    expect(state.liveCalls).toContainEqual({
      topics: ["issue:1"],
      keys: [["issues"]],
    });
  });
  it("shows read failures rather than an endless loading label", () => {
    state.readError = "/api/v1/issues/board";
    expect(render(<IssuesPage />)).toContain("Connection lost");
    state.readError = "/api/v1/issues/detail";
    expect(render(<IssueDetailPage number="1" />)).toContain("Connection lost");
    state.readError = "/api/v1/issues/access";
    expect(render(<IssuesPage />)).toContain("Connection lost");
  });
  it("explains missing restored bodies, comments and attachment bytes", () => {
    state.values["/api/v1/issues/detail"] = {
      ...detail,
      issue: {
        ...detail.issue,
        backup: {
          summaryOnly: true,
          missingComments: 7,
          missingAttachments: 2,
        },
      },
    };
    const html = render(<IssueDetailPage number="1" />);
    expect(html).toContain("Original issue details were not included");
    expect(html).toContain("7 earlier comments");
    expect(html).toContain("2 attachments are missing");
  });
  it("reuses the same intent key after a failed create", async () => {
    state.fields = { title: "Retry safely" };
    state.reject = "/api/v1/issues/create";
    render(<IssueCreatePage />);
    const submit = state.elements.find((e) => e.type === "form")!.props
      .onSubmit as (e: unknown) => Promise<void>;
    await submit(event(""));
    state.reject = "";
    await submit(event(""));
    expect(state.requestKeys).toHaveLength(2);
    expect(state.requestKeys[0]).toBeTruthy();
    expect(state.requestKeys[1]).toBe(state.requestKeys[0]);
  });
  it("shows actionable queue counts and labels the limited activity history", () => {
    state.values["/api/v1/issues/board"] = {
      issues: [card],
      counts,
      milestones: [],
      total: 1,
      truncated: false,
      summary: {
        open: 1,
        urgent: 1,
        unassigned: 1,
        readyForRetest: 0,
        completedThisWeek: 2,
        completedPriorWeek: 1,
      },
      trend: [{ date: "2026-10-19", opened: 1, completed: 2 }],
      historyNote: "v2 history only",
    };
    const html = render(<IssuesPage />);
    expect(html).toContain("What is blocking the rollout?");
    expect(html).toContain("Goal: no urgent blockers");
    expect(html).toContain("Moves to Done recorded: 2");
    expect(html).toContain("v2 history only");
    expect(html).toContain("Open without an owner");
    state.buttons.find((b) => b.label === "Open without an owner")!.onPress!();
  });
  it("hashes file bytes and sends bounded chunks until storage is confirmed", async () => {
    const file = new File(["1234567"], "video.mp4", { type: "video/mp4" });
    const claim = vi.fn().mockResolvedValue({
      uploadId: "blob",
      uploadToken: "spu_test",
      uploadUrl: "/upload",
      chunkUrl: "/chunks",
      chunkBytes: 3,
      expiresAt: Date.now() + 10000,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "pending" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "pending" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "stored", blobId: "blob" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    expect(await uploadIssueFiles([file], claim)).toEqual([
      { storageId: "blob", fileName: "video.mp4" },
    ]);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    expect(claim.mock.calls[0]![0]).toMatchObject({
      ownerId: null,
      size: 7,
      mime: "video/mp4",
      sha256: Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/chunks/0",
      "/chunks/1",
      "/chunks/2",
    ]);
    expect(fetchMock.mock.calls.map((c) => (c[1].body as Blob).size)).toEqual([
      3, 3, 1,
    ]);
  });
});
describe("attachment uploads", () => {
  it("enforces five files and validates MIME and size", () => {
    const file = new File(["evidence"], "evidence.png", { type: "image/png" });
    expect(selectedFileError(Array(6).fill(file), 1)).toContain("five");
    expect(
      selectedFileError(
        [new File(["bad"], "bad.exe", { type: "application/octet-stream" })],
        1,
      ),
    ).toContain("Use an image");
    expect(selectedFileError([file], 1)).toBeUndefined();
  });
  it("posts the original MIME and reuses successful uploads on retry", async () => {
    const file = new File(["evidence"], "evidence.png", { type: "image/png" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ blobId: "stored-1", status: "stored" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const generate = vi.fn().mockResolvedValue({
      uploadId: "stored-1",
      uploadToken: "spu_test",
      uploadUrl: "https://upload.example.com",
      chunkUrl: "/chunks",
      chunkBytes: 8 * 1024 * 1024,
      expiresAt: Date.now() + 10000,
    });
    const cache = new Map();
    expect(await uploadIssueFiles([file], generate, cache)).toEqual([
      { storageId: "stored-1", fileName: "evidence.png" },
    ]);
    await uploadIssueFiles([file], generate, cache);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://upload.example.com", {
      method: "PUT",
      headers: {
        "Content-Type": "image/png",
        Authorization: "Bearer spu_test",
      },
      body: file,
    });
  });
  it("rejects failed and malformed upload responses", async () => {
    const file = new File(["x"], "evidence.png", { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) }),
    );
    for (let i = 0; i < 2; i++)
      await expect(
        uploadIssueFiles([file], async () => ({
          uploadId: "stored-1",
          uploadToken: "spu_test",
          uploadUrl: "https://upload.example.com",
          chunkUrl: "/chunks",
          chunkBytes: 8 * 1024 * 1024,
          expiresAt: Date.now() + 10000,
        })),
      ).rejects.toThrow(/Upload/);
  });
});
