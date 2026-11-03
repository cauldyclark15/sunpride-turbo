/**
 * Contract fixtures (MESSAGING_V2 shapes, field for field) for tests and for
 * reviewing the UI without the API.
 */
import type {
  Attachment,
  Conversation,
  ConversationDetail,
  DirectoryUser,
  LinkPreview,
  Message,
  RefEntry,
  UnreadSummary,
  UserLite,
} from "./types";

export const ME: UserLite = {
  id: "11111111-1111-4111-8111-111111111111",
  display_name: "Maria Santos",
  avatar_url: null,
  is_agent: false,
};
export const ANA: UserLite = {
  id: "22222222-2222-4222-8222-222222222222",
  display_name: "Ana Cruz",
  avatar_url: "/api/media/avatars/ana.jpg",
  is_agent: false,
};
export const BEN: UserLite = {
  id: "33333333-3333-4333-8333-333333333333",
  display_name: "Ben Reyes",
  avatar_url: null,
  is_agent: false,
};
export const AGENT: UserLite = {
  id: "44444444-4444-4444-8444-444444444444",
  display_name: "Phantasm Scout",
  avatar_url: null,
  is_agent: true,
};

export const DIRECTORY: DirectoryUser[] = [
  { ...ANA, role_label: "Manager" },
  { ...BEN, role_label: "Sales" },
  { ...AGENT, role_label: "AI user" },
];

export const OUTLET_REF: RefEntry = {
  type: "outlet",
  id: "55555555-5555-4555-8555-555555555555",
  title: "Puregold Cubao",
  subtitle: "Quezon City · Route 4",
  thumb_url: "/api/media/outlets/puregold.jpg",
  href: "/stores/55555555-5555-4555-8555-555555555555",
  access: "ok",
};
export const PRODUCT_REF: RefEntry = {
  type: "product",
  id: "66666666-6666-4666-8666-666666666666",
  title: "Sunpride Banana Chips 100 g",
  subtitle: "SKU 10023",
  thumb_url: null,
  href: "/stock/66666666-6666-4666-8666-666666666666",
  access: "ok",
};
export const RESTRICTED_REF: RefEntry = {
  type: "order",
  id: "77777777-7777-4777-8777-777777777777",
  title: "Restricted item",
  subtitle: null,
  thumb_url: null,
  href: "/orders",
  access: "restricted",
};
export const USER_REF: RefEntry = {
  type: "user",
  id: ANA.id,
  title: ANA.display_name,
  subtitle: "Manager",
  thumb_url: ANA.avatar_url,
  href: `/coverage-people/${ANA.id}`,
  access: "ok",
};

export const IMAGE_ATTACHMENT: Attachment = {
  id: "88888888-8888-4888-8888-888888888881",
  name: "shelf.jpg",
  mime: "image/jpeg",
  bytes: 482_133,
  width: 1600,
  height: 1200,
  url: "/api/v1/messaging/attachments/88888888-8888-4888-8888-888888888881",
  thumb_url:
    "/api/v1/messaging/attachments/88888888-8888-4888-8888-888888888881/thumb",
  kind: "image",
};
export const FILE_ATTACHMENT: Attachment = {
  id: "88888888-8888-4888-8888-888888888882",
  name: "October sell-out.xlsx",
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  bytes: 2_621_440,
  width: null,
  height: null,
  url: "/api/v1/messaging/attachments/88888888-8888-4888-8888-888888888882",
  thumb_url: null,
  kind: "file",
};

export const LINK: LinkPreview = {
  url: "https://example.com/report",
  title: "Q3 retail report",
  description: "Shelf share across Metro Manila.",
  // SP-0148: the API never sends remote og:image URLs.
  image_url: null,
  site_name: "Example",
  status: "ready",
};

export const CHANNEL_ID = "99999999-9999-4999-8999-999999999991";
export const DM_ID = "99999999-9999-4999-8999-999999999992";
export const GROUP_ID = "99999999-9999-4999-8999-999999999993";
export const AGENT_DM_ID = "99999999-9999-4999-8999-999999999994";

export function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    conversation_id: CHANNEL_ID,
    seq: 1,
    author: ANA,
    body: "Morning team",
    parent_message_id: null,
    reply_count: 0,
    last_reply_at: null,
    attachments: [],
    refs: [],
    mentions_me: false,
    reactions: [],
    links: [],
    edited: false,
    deleted: false,
    created_at: "2026-11-03T01:00:00.000Z",
    ...overrides,
  };
}

export const MESSAGES: Message[] = [
  message({ seq: 1, created_at: "2026-11-02T01:00:00.000Z", body: "Yesterday's note" }),
  message({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    seq: 2,
    created_at: "2026-11-03T01:00:00.000Z",
    body: `Please check <#outlet:${OUTLET_REF.id}> with <@user:${BEN.id}>`,
    refs: [OUTLET_REF],
    reactions: [{ emoji: "👍", count: 2, mine: true }],
    reply_count: 2,
    last_reply_at: "2026-11-03T01:30:00.000Z",
  }),
  message({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    seq: 3,
    created_at: "2026-11-03T01:02:00.000Z",
    body: "Photos attached https://example.com/report",
    attachments: [IMAGE_ATTACHMENT, FILE_ATTACHMENT],
    links: [LINK],
    edited: true,
  }),
  message({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
    seq: 4,
    author: ME,
    created_at: "2026-11-03T01:10:00.000Z",
    body: "",
    deleted: true,
  }),
  message({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
    seq: 5,
    author: BEN,
    created_at: "2026-11-03T02:00:00.000Z",
    body: `<!channel> order <#order:${RESTRICTED_REF.id}> is late`,
    refs: [RESTRICTED_REF],
    mentions_me: true,
  }),
];

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: CHANNEL_ID,
    kind: "channel",
    title: "general",
    topic: "Company-wide news",
    is_private: false,
    members_preview: [ME, ANA, BEN],
    member_count: 12,
    unread_count: 0,
    mention_count: 0,
    last_message: null,
    muted: false,
    updated_at: "2026-11-03T02:00:00.000Z",
    ...overrides,
  };
}

export const CONVERSATIONS: Conversation[] = [
  conversation({
    unread_count: 2,
    mention_count: 1,
    last_message: {
      id: MESSAGES[4]!.id,
      seq: 5,
      author: BEN,
      body: MESSAGES[4]!.body,
      created_at: MESSAGES[4]!.created_at,
      deleted: false,
    },
  }),
  conversation({
    id: DM_ID,
    kind: "dm",
    title: null,
    topic: null,
    members_preview: [ME, ANA],
    member_count: 2,
    unread_count: 1,
    last_message: {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      seq: 9,
      author: ANA,
      body: `Can you visit <#outlet:${OUTLET_REF.id}>?`,
      created_at: "2026-11-03T01:40:00.000Z",
      deleted: false,
    },
  }),
  conversation({
    id: GROUP_ID,
    kind: "group",
    title: null,
    topic: null,
    members_preview: [ME, ANA, BEN],
    member_count: 3,
  }),
  conversation({
    id: AGENT_DM_ID,
    kind: "dm",
    title: null,
    topic: null,
    members_preview: [ME, AGENT],
    member_count: 2,
  }),
];

export const CHANNEL_DETAIL: ConversationDetail = {
  ...CONVERSATIONS[0]!,
  members: [
    { ...ME, role: "owner", last_read_seq: 3 },
    { ...ANA, role: "member", last_read_seq: 5 },
    { ...BEN, role: "member", last_read_seq: 5 },
  ],
};

export const UNREAD: UnreadSummary = {
  me: { id: ME.id, display_name: ME.display_name },
  total: 3,
  mentions: 1,
  conversations: [
    { id: CHANNEL_ID, unread_count: 2, mention_count: 1 },
    { id: DM_ID, unread_count: 1, mention_count: 0 },
  ],
};
