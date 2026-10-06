import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "@sunpride/backend/data-model";
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
vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    state.queryCalls.push({ name, args });
    return args === "skip" ? undefined : state.values[name];
  },
  useMutation: (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    state.mutations.push({ name, args });
    if (name === state.reject) throw new Error("Rejected");
    if (name === "issues/mutations:generateUploadUrl")
      return "https://upload.example.com";
    if (name === "issues/mutations:create")
      return { issueId: "issue-1", number: 42, key: "SP-0042" };
    return {};
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (href: string) => state.pushes.push(href) }),
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
const id = <
  T extends
    | "issues"
    | "profiles"
    | "issueAttachments"
    | "issueComments"
    | "issueActivity",
>(
  value: string,
) => value as Id<T>;
const timestamp = Date.UTC(2026, 9, 2, 12);
const card: IssueCard = {
  _id: id<"issues">("issue-1"),
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
    _id: id<"issueAttachments">("image"),
    fileName: "evidence.png",
    fileType: "image/png",
    fileSize: 2048,
    kind: "image",
    url: "https://example.com/evidence.png",
  },
  {
    _id: id<"issueAttachments">("video"),
    fileName: "recording.mp4",
    fileType: "video/mp4",
    fileSize: 4096,
    kind: "video",
    url: "https://example.com/recording.mp4",
  },
  {
    _id: id<"issueAttachments">("document"),
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
    _creationTime: timestamp,
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
    searchText: "order",
    archived: false,
    milestone: "Launch",
    externalRef: "SOP-004",
    assigneeId: id<"profiles">("ben"),
    reporterId: id<"profiles">("ana"),
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
      _id: id<"issueComments">("comment-1"),
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
      _id: id<"issueActivity">("event-1"),
      kind: "status_changed",
      actorName: "Ben",
      fromStatus: "draft",
      toStatus: "ongoing_test",
      changes: undefined,
      note: undefined,
      createdAt: timestamp,
    },
    {
      _id: id<"issueActivity">("event-2"),
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
    "domains/profiles:current": { status: "active", role: "admin" },
    "issues/queries:access": {
      canRead: true,
      canWrite: true,
      canTriage: true,
      canManage: true,
      maxVideoBytes: 75 * 1024 * 1024,
    },
    "issues/queries:board": {
      issues: [card],
      counts,
      milestones: ["Launch"],
      truncated: false,
    },
    "issues/queries:assignees": [{ _id: "ben", name: "Ben", role: "admin" }],
    "issues/queries:detail": detail,
  };
  state.queryCalls = [];
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
            _id: id<"issues">("issue-2"),
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
      _id: id<"issues">(`issue-${index}`),
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
      state.queryCalls.find((call) => call.name === "issues/queries:board")
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
    state.values["issues/queries:board"] = {
      issues: [card],
      counts,
      milestones: [],
      truncated: true,
    };
    state.values["issues/queries:access"] = {
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
      "Create issue",
    ])
      expect(html).toContain(text);
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
      state.mutations.find((call) => call.name === "issues/mutations:create")
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
    state.values["issues/queries:access"] = {
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
      (call) => call.name === "issues/mutations:create",
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
    state.reject = "issues/mutations:create";
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
    state.values["issues/queries:access"] = {
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
    state.values["domains/profiles:current"] = {
      status: "active",
      role: "sales",
    };
    state.values["issues/queries:access"] = {
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
    state.values["issues/queries:detail"] = {
      ...detail,
      issue: { ...detail.issue, archived: true },
    };
    const html = render(<IssueDetailPage number="1" />);
    expect(html).toContain("Restore issue");
    expect(html).not.toContain("Issue status");
    expect(html).not.toContain("Add a comment");
  });
  it("renders the not-found and loading states", () => {
    state.values["issues/queries:detail"] = null;
    expect(render(<IssueDetailPage number="bad" />)).toContain(
      "Issue not found",
    );
    state.values["issues/queries:detail"] = undefined;
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
    }
    expect(state.mutations).toEqual([
      {
        name: "issues/mutations:move",
        args: { issueId: "issue-1", status: "ongoing_test" },
      },
      {
        name: "issues/mutations:update",
        args: { issueId: "issue-1", area: "Home" },
      },
      {
        name: "issues/mutations:update",
        args: { issueId: "issue-1", priority: "critical" },
      },
      {
        name: "issues/mutations:update",
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
describe("interaction contracts", () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  function button(label: string) {
    return state.buttons.find((item) => item.label === label)!;
  }
  function event(value: string) {
    return { preventDefault: vi.fn(), target: { value } };
  }
  it("paginates to the remaining rows", () => {
    state.page = 2;
    const rows = Array.from({ length: 26 }, (_, index) => ({
      ...card,
      _id: id<"issues">(`issue-${index}`),
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
      _id: id<"issues">("destination"),
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
      { name: "issues/mutations:archive", args: { issueId: "issue-1" } },
      {
        name: "issues/mutations:deleteComment",
        args: { commentId: "comment-1" },
      },
      {
        name: "issues/mutations:removeAttachment",
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
    state.values["issues/queries:detail"] = {
      ...detail,
      issue: { ...detail.issue, archived: true },
    };
    render(<IssueDetailPage number="1" />);
    button("Restore issue").onPress!();
    await flush();
    expect(state.mutations).toEqual([
      { name: "issues/mutations:restore", args: { issueId: "issue-1" } },
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
        name: "issues/mutations:addComment",
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
        name: "issues/mutations:updateComment",
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
        json: async () => ({ storageId: "storage-1" }),
      }),
    );
    render(<IssueCreatePage />);
    const form = state.elements.find((element) => element.type === "form")!;
    await (form.props.onSubmit as (event: unknown) => Promise<void>)(event(""));
    expect(state.mutations.map((call) => call.name)).toEqual([
      "issues/mutations:generateUploadUrl",
      "issues/mutations:create",
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
        name: "issues/mutations:update",
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
      state.values["domains/profiles:current"] = {
        role: "contractor",
        status: "active",
      };
      const html = render(<Component />);
      expect(html).toContain("No access");
      expect(
        state.queryCalls
          .filter((call) => call.name.startsWith("issues/"))
          .every((call) => call.args === "skip"),
      ).toBe(true);
    },
  );
  it("skips data queries when backend denies read access", () => {
    state.values["issues/queries:access"] = {
      canRead: false,
      canWrite: false,
      canManage: false,
      maxVideoBytes: 1,
    };
    expect(render(<IssuesPage />)).toContain("No access");
    expect(
      state.queryCalls.find((call) => call.name === "issues/queries:board")
        ?.args,
    ).toBe("skip");
  });
  it("skips issue queries for inactive profiles", () => {
    state.values["domains/profiles:current"] = {
      role: "admin",
      status: "inactive",
    };
    expect(render(<IssuesPage />)).toContain("No access");
    expect(
      state.queryCalls
        .filter((call) => call.name.startsWith("issues/"))
        .every((call) => call.args === "skip"),
    ).toBe(true);
  });
  it("denies create for read-only accounts", () => {
    state.values["issues/queries:access"] = {
      canRead: true,
      canWrite: false,
      canManage: false,
      maxVideoBytes: 1,
    };
    expect(render(<IssueCreatePage />)).toContain("No access");
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
      json: async () => ({ storageId: "stored-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const generate = vi.fn().mockResolvedValue("https://upload.example.com");
    const cache = new Map();
    expect(await uploadIssueFiles([file], generate, cache)).toEqual([
      { storageId: "stored-1", fileName: "evidence.png" },
    ]);
    await uploadIssueFiles([file], generate, cache);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://upload.example.com", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: file,
    });
  });
  it("rejects failed and malformed upload responses", async () => {
    const file = new File(["x"], "evidence.png", { type: "image/png" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) }),
    );
    for (let i = 0; i < 2; i++)
      await expect(
        uploadIssueFiles([file], async () => "https://upload.example.com"),
      ).rejects.toThrow("Upload failed");
  });
});
