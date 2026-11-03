/**
 * Messaging wire types, exactly as docs/architecture/MESSAGING_V2.md names
 * them. Field names are the server's (snake_case); never rename them here.
 */

export type ConversationKind = "dm" | "group" | "channel";

export const REF_TYPES = [
  "user",
  "outlet",
  "product",
  "customer",
  "issue",
  "order",
  "visit",
  "territory",
  "route",
  "van_trip",
] as const;
export type RefType = (typeof REF_TYPES)[number];

export type UserLite = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  is_agent: boolean;
};

export type DirectoryUser = UserLite & { role_label: string };

export type Member = UserLite & {
  role: "owner" | "member";
  last_read_seq: number;
};

export type RefEntry = {
  type: RefType;
  id: string;
  title: string;
  subtitle: string | null;
  thumb_url: string | null;
  href: string;
  access: "ok" | "restricted" | "missing";
};

export type Attachment = {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  url: string;
  thumb_url: string | null;
  kind: "image" | "file";
};

export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  image_url: string | null;
  site_name: string | null;
  status: string;
};

export type Reaction = { emoji: string; count: number; mine: boolean };

export type Message = {
  id: string;
  conversation_id: string;
  seq: number;
  author: UserLite;
  body: string;
  parent_message_id: string | null;
  reply_count: number;
  last_reply_at: string | null;
  attachments: Attachment[];
  refs: RefEntry[];
  mentions_me: boolean;
  reactions: Reaction[];
  links: LinkPreview[];
  edited: boolean;
  deleted: boolean;
  created_at: string;
};

/** `last_message` in a conversation row; the contract names it MessageLite. */
export type MessageLite = Pick<
  Message,
  "id" | "seq" | "author" | "body" | "created_at"
> &
  Partial<Pick<Message, "deleted" | "conversation_id">>;

export type Conversation = {
  id: string;
  kind: ConversationKind;
  title: string | null;
  topic: string | null;
  is_private: boolean;
  members_preview: UserLite[];
  member_count: number;
  unread_count: number;
  mention_count: number;
  last_message: MessageLite | null;
  muted: boolean;
  updated_at: string;
};

export type ConversationDetail = Conversation & { members: Member[] };

export type ConversationPage = {
  items: Conversation[];
  next_cursor: string | null;
};

export type MessagePage = { items: Message[]; has_more: boolean };

export type UnreadSummary = {
  total: number;
  mentions: number;
  conversations: { id: string; unread_count: number; mention_count: number }[];
};

export type SearchHit = Message & {
  conversation: { id: string; title: string | null; kind: ConversationKind };
};

export type SearchPage = { items: SearchHit[]; next_cursor: string | null };

export type AttachmentClaim = {
  attachment_id: string;
  upload_url: string;
  expires_at: string;
};

export type NewConversation =
  | { kind: "dm"; user_ids: string[] }
  | { kind: "group"; user_ids: string[]; title?: string }
  | { kind: "channel"; title: string; topic?: string; is_private?: boolean };
