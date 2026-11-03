import { apiFetch, type ApiFetchOptions } from "../api";
import type {
  AttachmentClaim,
  Conversation,
  ConversationDetail,
  ConversationPage,
  DirectoryUser,
  Message,
  MessagePage,
  NewConversation,
  RefEntry,
  RefType,
  SearchPage,
  UnreadSummary,
} from "./types";

/** Base path of every messaging route (MESSAGING_V2 "HTTP API"). */
export const MESSAGING_BASE = "/api/v1/messaging";

type Transport = Pick<ApiFetchOptions, "fetchImpl" | "signal">;

const path = (suffix: string) => `${MESSAGING_BASE}${suffix}`;
const id = (value: string) => encodeURIComponent(value);

/** Typed client for `/api/v1/messaging/*`. Every call is same-origin JSON. */
export function messagingClient(transport: Transport = {}) {
  const get = <T>(suffix: string, query?: ApiFetchOptions["query"]) =>
    apiFetch<T>(path(suffix), { ...transport, query });
  const send = <T>(
    method: "POST" | "PATCH" | "DELETE",
    suffix: string,
    body?: unknown,
  ) =>
    apiFetch<T>(path(suffix), {
      ...transport,
      method,
      body: method === "DELETE" ? undefined : (body ?? {}),
    });

  return {
    listConversations: (cursor?: string | null) =>
      get<ConversationPage>("/conversations", { cursor: cursor ?? undefined }),
    createConversation: (input: NewConversation) =>
      send<Conversation>("POST", "/conversations", input),
    getConversation: (conversationId: string) =>
      get<ConversationDetail>(`/conversations/${id(conversationId)}`),
    updateConversation: (
      conversationId: string,
      patch: { title?: string; topic?: string; muted?: boolean },
    ) =>
      send<Conversation>("PATCH", `/conversations/${id(conversationId)}`, patch),
    addMembers: (conversationId: string, userIds: string[]) =>
      send<unknown>("POST", `/conversations/${id(conversationId)}/members`, {
        user_ids: userIds,
      }),
    removeMember: (conversationId: string, userId: string) =>
      send<unknown>(
        "DELETE",
        `/conversations/${id(conversationId)}/members/${id(userId)}`,
      ),
    /** Public channels the caller has not joined: a bare list, no paging. */
    browseChannels: (q?: string) =>
      get<Conversation[]>("/channels/browse", {
        q: q || undefined,
      }),
    joinChannel: (conversationId: string) =>
      send<ConversationDetail>(
        "POST",
        `/conversations/${id(conversationId)}/join`,
      ),

    listMessages: (
      conversationId: string,
      options: {
        before_seq?: number;
        after_seq?: number;
        limit?: number;
        thread?: string;
      } = {},
    ) =>
      get<MessagePage>(`/conversations/${id(conversationId)}/messages`, {
        before_seq: options.before_seq,
        after_seq: options.after_seq,
        limit: options.limit ?? 50,
        thread: options.thread,
      }),
    sendMessage: (
      conversationId: string,
      input: {
        client_msg_id: string;
        body: string;
        parent_message_id?: string;
        attachment_ids?: string[];
      },
    ) =>
      send<Message>("POST", `/conversations/${id(conversationId)}/messages`, input),
    editMessage: (messageId: string, body: string) =>
      send<Message>("PATCH", `/messages/${id(messageId)}`, { body }),
    deleteMessage: (messageId: string) =>
      send<unknown>("DELETE", `/messages/${id(messageId)}`),
    addReaction: (messageId: string, emoji: string) =>
      send<unknown>("POST", `/messages/${id(messageId)}/reactions`, { emoji }),
    removeReaction: (messageId: string, emoji: string) =>
      send<unknown>(
        "DELETE",
        `/messages/${id(messageId)}/reactions/${id(emoji)}`,
      ),
    markRead: (conversationId: string, seq: number) =>
      send<unknown>("POST", `/conversations/${id(conversationId)}/read`, {
        seq,
      }),

    claimAttachment: (input: {
      name: string;
      mime: string;
      bytes: number;
      sha256: string;
      role: "file" | "thumb";
      of_attachment_id?: string;
    }) => send<AttachmentClaim>("POST", "/attachments/claim", input),

    searchUsers: (q: string, limit = 20) =>
      get<DirectoryUser[]>("/users/search", { q, limit }),
    searchRefs: (q: string, types?: readonly RefType[], limit = 20) =>
      get<RefEntry[]>("/refs/search", {
        q,
        types: types?.length ? types.join(",") : undefined,
        limit,
      }),
    resolveRefs: (refs: { type: RefType; id: string }[]) =>
      send<RefEntry[]>("POST", "/refs/resolve", { refs }),

    unread: () => get<UnreadSummary>("/unread"),
    search: (q: string, cursor?: string | null) =>
      get<SearchPage>("/search", { q, cursor: cursor ?? undefined }),
  };
}

export type MessagingClient = ReturnType<typeof messagingClient>;

/** `/channels/browse` returns a bare list. */
export function browseItems(
  result: Conversation[] | null | undefined,
): Conversation[] {
  return Array.isArray(result) ? result : [];
}

/** Stable id for an idempotent send (`client_msg_id`). */
export function newClientMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
