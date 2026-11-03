"use client";

import { useMemo } from "react";
import { useApi, useApiPages, useLive } from "../api";
import { messagingClient } from "./client";
import type {
  Conversation,
  ConversationDetail,
  MessagePage,
  UnreadSummary,
} from "./types";

export const messagingKeys = {
  all: ["messaging"] as const,
  conversations: ["messaging", "conversations"] as const,
  conversation: (id: string) => ["messaging", "conversation", id] as const,
  messages: (id: string) => ["messaging", "messages", id] as const,
  thread: (id: string, parentId: string) =>
    ["messaging", "messages", id, { thread: parentId }] as const,
  unread: ["messaging", "unread"] as const,
};

/** Realtime topics (MESSAGING_V2 "Realtime"). */
export const userTopic = (userId: string) => `messaging.user:${userId}`;
export const conversationTopic = (conversationId: string) =>
  `messaging.conv:${conversationId}`;

/**
 * What each topic refreshes. The hub only says "something changed"; the
 * matching keys refetch.
 */
export function liveRegistrations(
  meId: string | null | undefined,
  conversationId: string | null | undefined,
) {
  const registrations: { topic: string; keys: (readonly unknown[])[] }[] = [];
  if (meId)
    registrations.push({
      topic: userTopic(meId),
      keys: [
        messagingKeys.conversations,
        messagingKeys.unread,
        ["messaging", "conversation"],
      ],
    });
  if (conversationId)
    registrations.push({
      topic: conversationTopic(conversationId),
      keys: [
        messagingKeys.messages(conversationId),
        messagingKeys.conversation(conversationId),
      ],
    });
  return registrations;
}

/** Subscribes `messaging.user:<me>` and, when open, `messaging.conv:<id>`. */
export function useMessagingLive(
  meId: string | null | undefined,
  conversationId: string | null | undefined,
) {
  const [user, conversation] = [
    meId ? liveRegistrations(meId, null)[0] : undefined,
    conversationId ? liveRegistrations(null, conversationId)[0] : undefined,
  ];
  useLive(user ? user.topic : null, user?.keys ?? []);
  useLive(conversation ? conversation.topic : null, conversation?.keys ?? []);
}

const client = messagingClient();

/** Unread totals for the nav badge; `null` skips (no access or signed out). */
export function useMessagingUnread(meId: string | null | undefined) {
  const result = useApi<UnreadSummary>(
    meId ? messagingKeys.unread : null,
    ({ signal }) => messagingClient({ signal }).unread(),
  );
  useLive(meId ? userTopic(meId) : null, [messagingKeys.unread]);
  return result.data;
}

export function useConversations(enabled: boolean) {
  return useApiPages<Conversation>(
    enabled ? messagingKeys.conversations : null,
    async (cursor, { signal }) => {
      const page = await messagingClient({ signal }).listConversations(cursor);
      return { items: page.items, nextCursor: page.next_cursor };
    },
  );
}

export function useConversation(conversationId: string | null) {
  return useApi<ConversationDetail>(
    conversationId ? messagingKeys.conversation(conversationId) : null,
    ({ signal }) =>
      messagingClient({ signal }).getConversation(conversationId ?? ""),
  );
}

/** Latest page of top-level messages, or of one thread's replies. */
export function useLatestMessages(
  conversationId: string | null,
  threadId: string | null = null,
) {
  const key = useMemo(
    () =>
      conversationId
        ? threadId
          ? messagingKeys.thread(conversationId, threadId)
          : messagingKeys.messages(conversationId)
        : null,
    [conversationId, threadId],
  );
  return useApi<MessagePage>(key, ({ signal }) =>
    messagingClient({ signal }).listMessages(conversationId ?? "", {
      limit: 50,
      thread: threadId ?? undefined,
    }),
  );
}

export { client as defaultMessagingClient };
