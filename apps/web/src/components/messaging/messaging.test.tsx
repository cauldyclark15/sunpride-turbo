import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_DETAIL,
  CHANNEL_ID,
  CONVERSATIONS,
  DIRECTORY,
  IMAGE_ATTACHMENT,
  ME,
  MESSAGES,
  OUTLET_REF,
  RESTRICTED_REF,
} from "../../lib/messaging/fixtures";
import type { MessagingActions } from "./actions";

const state = vi.hoisted(() => ({
  escapes: [] as (() => void)[],
  live: [] as unknown[],
  conversations: [] as unknown[],
  messages: [] as unknown[],
  role: "sales",
}));

vi.mock("../../lib/messaging/escape", async (original) => ({
  ...(await original<typeof import("../../lib/messaging/escape")>()),
  useEscape: (onClose: () => void, active = true) => {
    if (active) state.escapes.push(onClose);
  },
}));

vi.mock("../../lib/api", async (original) => {
  const actual = await original<typeof import("../../lib/api")>();
  const fixtures = await import("../../lib/messaging/fixtures");
  const byKey = (key: readonly unknown[] | null) => {
    if (!key) return undefined;
    const [, kind, id] = key as [string, string, string];
    switch (kind) {
      case "conversation":
        return { ...fixtures.CHANNEL_DETAIL, id };
      case "messages":
        return { items: state.messages, has_more: true };
      case "unread":
        return fixtures.UNREAD;
      case "users":
        return fixtures.DIRECTORY;
      case "refs":
        return [fixtures.OUTLET_REF, fixtures.PRODUCT_REF, fixtures.RESTRICTED_REF];
      case "search":
        return { items: [{ ...fixtures.MESSAGES[1], conversation: { id: fixtures.CHANNEL_ID, title: "general", kind: "channel" } }], next_cursor: null };
      case "browse":
        return [fixtures.CONVERSATIONS[0]];
      default:
        return undefined;
    }
  };
  return {
    ...actual,
    useApi: (key: readonly unknown[] | null) => ({
      data: byKey(key),
      error: undefined,
      status: key ? "success" : "idle",
      isLoading: false,
      isFetching: false,
      refetch: async () => {},
    }),
    useApiPages: (key: readonly unknown[] | null) => ({
      items: key ? state.conversations : undefined,
      status: key ? "exhausted" : "idle",
      error: undefined,
      loadMore: async () => {},
    }),
    useLive: (topics: unknown) => {
      if (topics) state.live.push(topics);
    },
    useApiStore: () => ({ invalidate: () => {} }),
  };
});

vi.mock("../../lib/auth/session", () => ({
  useSession: () => ({
    profile: { id: "profile-1", subject: ME.id, name: ME.display_name, role: state.role },
    me: null,
  }),
  usePermissions: () => ({ role: state.role, permissions: new Set(), can: () => false }),
}));

const { MessagesPage, chatSelf, phonePane } = await import("./messages-page");
const { ThreadPanel } = await import("./conversation-view");
const { DetailsPanel, SearchPanel } = await import("./side-panels");
const { NewConversationDialog, BrowseChannelsDialog } = await import("./new-conversation");
const { Lightbox, EmojiPicker } = await import("./message-parts");
const { RefCard, MessageBody } = await import("./message-body");
const { SidePanel, ModalFrame } = await import("./primitives");
const { Composer, keyIntent } = await import("./composer");
const { createActions } = await import("./actions");
const { Outbox } = await import("../../lib/messaging/outbox");

const actions = createActions(
  { claimAttachment: vi.fn() } as never,
  () => {},
  new Outbox(),
) as MessagingActions;

beforeEach(() => {
  state.escapes = [];
  state.live = [];
  state.conversations = CONVERSATIONS;
  state.messages = MESSAGES;
  state.role = "sales";
});

const render = (node: ReactElement) => renderToStaticMarkup(node);

describe("messages page", () => {
  it("shows the four sidebar sections with unread and mention badges", () => {
    const html = render(createElement(MessagesPage));
    for (const label of ["Channels", "Direct messages", "Groups", "AI users"])
      expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('aria-label="2 unread"');
    expect(html).toContain('aria-label="1 mention"');
    expect(html).toContain("Phantasm Scout");
    expect(html).toContain(">AI<");
    expect(html).toContain("Start a conversation");
    expect(html).toContain("Pick a conversation");
  });

  it("renders a conversation: chips, restricted refs, files, previews, edits, deletes, New divider", () => {
    const html = render(createElement(MessagesPage, { initialConversationId: CHANNEL_ID }));
    expect(html).toContain("Puregold Cubao");
    expect(html).toContain(`src="${OUTLET_REF.thumb_url}"`);
    expect(html).toContain("Restricted item");
    expect(html).toContain("@Ben Reyes");
    expect(html).toContain("@channel");
    expect(html).toContain(`src="${IMAGE_ATTACHMENT.thumb_url}"`);
    expect(html).toContain("October sell-out.xlsx");
    expect(html).toContain("2.5 MB");
    expect(html).toContain("Q3 retail report");
    expect(html).toContain("(edited)");
    expect(html).toContain("This message was deleted.");
    expect(html).toContain("2 replies");
    expect(html).toContain('aria-label="New messages"');
    expect(html).toContain("Load older messages");
    expect(html).toMatch(/👍/);
    // Never a raw token on screen.
    expect(html).not.toMatch(/&lt;[@#!]/);
    expect(html).not.toContain(RESTRICTED_REF.id);
    expect(state.live).toEqual(
      expect.arrayContaining([`messaging.user:${ME.id}`, `messaging.conv:${CHANNEL_ID}`]),
    );
  });

  it("hover actions offer thread, react, edit and delete on your own message, copy link everywhere", () => {
    state.messages = [{ ...MESSAGES[1]!, author: ME }];
    const html = render(createElement(MessagesPage, { initialConversationId: CHANNEL_ID }));
    for (const label of ["Reply in thread", "Add reaction", "Edit message", "Delete message", "Copy link"])
      expect(html).toContain(`aria-label="${label}"`);
    state.messages = [MESSAGES[1]!];
    const other = render(createElement(MessagesPage, { initialConversationId: CHANNEL_ID }));
    expect(other).not.toContain('aria-label="Edit message"');
    expect(other).not.toContain('aria-label="Delete message"');
  });

  it("hides messaging from partners", () => {
    state.role = "distributor";
    expect(render(createElement(MessagesPage))).toContain("Messages are for Sunpride staff");
  });

  it("stacks list, conversation and panel on a phone", () => {
    expect(phonePane(null, null)).toBe("list");
    expect(phonePane("c1", null)).toBe("conversation");
    expect(phonePane("c1", { kind: "details" })).toBe("panel");
    expect(phonePane(null, { kind: "search" })).toBe("panel");
    expect(chatSelf({ subject: ME.id, name: "Maria" })?.id).toBe(ME.id);
  });

  it("takes the caller's identity from GET /unread `me`, falling back to the profile", () => {
    const canonical = { id: "c0ffee00-0000-4000-8000-000000000001", display_name: "Maria Santos" };
    expect(chatSelf({ subject: ME.id, name: "Maria" }, canonical)).toEqual({
      id: canonical.id,
      display_name: "Maria Santos",
      avatar_url: null,
      is_agent: false,
    });
    expect(chatSelf(null, canonical)?.id).toBe(canonical.id);
    expect(chatSelf({ subject: ME.id, name: "Maria" }, null)?.id).toBe(ME.id);
  });
});

describe("composer", () => {
  it("sends on Enter, adds a line on Shift+Enter and ignores IME composition", () => {
    expect(keyIntent({ key: "Enter", shiftKey: false })).toBe("send");
    expect(keyIntent({ key: "Enter", shiftKey: true })).toBe("newline");
    expect(keyIntent({ key: "Enter", shiftKey: false, isComposing: true })).toBeNull();
    expect(keyIntent({ key: "a", shiftKey: false })).toBeNull();
  });

  it("has attach, emoji and send controls", () => {
    const html = render(
      createElement(Composer, { placeholder: "Message #general", client: actions.client, onSend: () => {} }),
    );
    expect(html).toContain('aria-label="Attach files"');
    expect(html).toContain('aria-label="Add emoji"');
    expect(html).toContain('aria-label="Message #general"');
    expect(html).toContain("Send");
  });

  it("renders ref chips with a type icon when there is no thumbnail", () => {
    const html = render(
      createElement(MessageBody, {
        body: `<#product:66666666-6666-4666-8666-666666666666>`,
        refs: [],
        lookup: { user: () => undefined, ref: () => undefined },
      }),
    );
    expect(html).toContain("Item");
    expect(html).toContain("<svg");
  });
});

/** Finds the close button in a rendered element tree (no DOM needed). */
function findClose(node: ReactNode): (() => void) | undefined {
  if (!isValidElement(node)) {
    if (Array.isArray(node)) for (const child of node) { const hit = findClose(child); if (hit) return hit; }
    return undefined;
  }
  const props = node.props as { label?: string; onClick?: () => void; children?: ReactNode };
  if (typeof props.label === "string" && props.label.startsWith("Close") && props.onClick) return props.onClick;
  return findClose(props.children);
}

describe("every panel closes with a close control and with Escape", () => {
  const parent = MESSAGES[1]!;
  const conversation = CHANNEL_DETAIL;
  const panels: [string, (onClose: () => void) => ReactElement][] = [
    ["thread", (onClose) => createElement(ThreadPanel, { conversation, parent, me: ME, canModerate: false, actions, onClose })],
    ["details", (onClose) => createElement(DetailsPanel, { conversation, me: ME, isAdmin: false, actions, onClose, onLeft: () => {} })],
    ["search", (onClose) => createElement(SearchPanel, { me: ME, onClose, onOpenHit: () => {} })],
    ["new direct message", (onClose) => createElement(NewConversationDialog, { mode: "dm", meId: ME.id, actions, onClose, onCreated: () => {} })],
    ["new group", (onClose) => createElement(NewConversationDialog, { mode: "group", meId: ME.id, actions, onClose, onCreated: () => {} })],
    ["new channel", (onClose) => createElement(NewConversationDialog, { mode: "channel", meId: ME.id, actions, onClose, onCreated: () => {} })],
    ["browse channels", (onClose) => createElement(BrowseChannelsDialog, { actions, onClose, onJoined: () => {} })],
    ["lightbox", (onClose) => createElement(Lightbox, { image: IMAGE_ATTACHMENT, onClose })],
    ["ref card", (onClose) => createElement(RefCard, { entry: OUTLET_REF, type: "outlet", onClose })],
    ["emoji picker", (onClose) => createElement(EmojiPicker, { onPick: () => {}, onClose })],
  ];

  it.each(panels)("%s", (_name, make) => {
    const onClose = vi.fn();
    const html = render(make(onClose));
    expect(html).toMatch(/<button[^>]*aria-label="Close [^"]+"/);
    expect(state.escapes.length).toBeGreaterThan(0);
    state.escapes[0]!();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the panel frames wire their close button to onClose", () => {
    const side = vi.fn();
    findClose(SidePanel({ title: "Thread", onClose: side, children: null }))?.();
    expect(side).toHaveBeenCalledTimes(1);
    const modal = vi.fn();
    findClose(ModalFrame({ title: "New group", onClose: modal, children: null }))?.();
    expect(modal).toHaveBeenCalledTimes(1);
  });

  it("people search marks AI users", () => {
    const html = render(createElement(NewConversationDialog, { mode: "dm", meId: ME.id, actions, onClose: () => {}, onCreated: () => {} }));
    for (const person of DIRECTORY) expect(html).toContain(person.display_name);
    expect(html).toContain(">AI<");
  });
});

describe("SP-0148 link preview images", () => {
  it("never loads a remote og:image, only a same-origin picture", async () => {
    const { LinkPreviewCard } = await import("./message-parts");
    const { LINK } = await import("../../lib/messaging/fixtures");
    for (const image_url of [
      null,
      "https://images.example/pixel.png",
      "http://10.0.0.1/admin",
      "//evil.example/x.png",
    ]) {
      const html = renderToStaticMarkup(
        createElement(LinkPreviewCard, { link: { ...LINK, image_url } }),
      );
      expect(html).toContain("Q3 retail report");
      expect(html).not.toContain("<img");
    }
    const own = renderToStaticMarkup(
      createElement(LinkPreviewCard, {
        link: { ...LINK, image_url: "/api/v1/messaging/previews/abc/image" },
      }),
    );
    expect(own).toContain('src="/api/v1/messaging/previews/abc/image"');
  });
});
