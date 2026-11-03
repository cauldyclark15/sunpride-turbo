"use client";

import { useMemo } from "react";
import { useApiStore } from "../../lib/api";
import { messagingClient, type MessagingClient } from "../../lib/messaging/client";
import { messagingKeys } from "../../lib/messaging/hooks";
import { Outbox } from "../../lib/messaging/outbox";
import type { Message } from "../../lib/messaging/types";

/** One outbox for the page: pending sends survive switching conversations. */
export const pageOutbox = new Outbox();

export type MessagingActions = ReturnType<typeof createActions>;

/**
 * Commands that refresh what they change. Other viewers hear about it from
 * the realtime hub.
 */
export function createActions(
  client: MessagingClient,
  invalidate: (keys: (readonly unknown[])[]) => void,
  outbox: Outbox = pageOutbox,
) {
  const touched = (conversationId: string) =>
    invalidate([
      messagingKeys.messages(conversationId),
      messagingKeys.conversation(conversationId),
      messagingKeys.conversations,
      messagingKeys.unread,
    ]);

  async function deliver(clientMsgId: string) {
    const item = outbox.get(clientMsgId);
    if (!item) return;
    outbox.sending(clientMsgId);
    try {
      const sent: Message = await client.sendMessage(item.conversation_id, {
        client_msg_id: item.client_msg_id,
        body: item.body,
        ...(item.parent_message_id
          ? { parent_message_id: item.parent_message_id }
          : {}),
        ...(item.attachment_ids.length
          ? { attachment_ids: item.attachment_ids }
          : {}),
      });
      outbox.sent(clientMsgId, sent.id);
      touched(item.conversation_id);
    } catch (error) {
      outbox.failed(
        clientMsgId,
        error instanceof Error && error.message
          ? error.message
          : "Not sent. Check your connection.",
      );
    }
  }

  return {
    client,
    outbox,
    /** Optimistic send: shows at once, retried with the same client_msg_id. */
    send(input: {
      conversationId: string;
      clientMsgId: string;
      body: string;
      parentId?: string | null;
      attachmentIds?: string[];
    }) {
      outbox.add({
        client_msg_id: input.clientMsgId,
        conversation_id: input.conversationId,
        parent_message_id: input.parentId ?? null,
        body: input.body,
        attachment_ids: input.attachmentIds ?? [],
        created_at: new Date().toISOString(),
      });
      return deliver(input.clientMsgId);
    },
    retry: deliver,
    discard: (clientMsgId: string) => outbox.remove(clientMsgId),
    async edit(message: Message, body: string) {
      await client.editMessage(message.id, body);
      touched(message.conversation_id);
    },
    async remove(message: Message) {
      await client.deleteMessage(message.id);
      touched(message.conversation_id);
    },
    async react(message: Message, emoji: string, mine: boolean) {
      if (mine) await client.removeReaction(message.id, emoji);
      else await client.addReaction(message.id, emoji);
      invalidate([messagingKeys.messages(message.conversation_id)]);
    },
    async markRead(conversationId: string, seq: number) {
      await client.markRead(conversationId, seq);
      invalidate([messagingKeys.conversations, messagingKeys.unread]);
    },
    async update(
      conversationId: string,
      patch: { title?: string; topic?: string; muted?: boolean },
    ) {
      await client.updateConversation(conversationId, patch);
      touched(conversationId);
    },
    async addMembers(conversationId: string, userIds: string[]) {
      await client.addMembers(conversationId, userIds);
      touched(conversationId);
    },
    async removeMember(conversationId: string, userId: string) {
      await client.removeMember(conversationId, userId);
      touched(conversationId);
    },
    async join(conversationId: string) {
      const conversation = await client.joinChannel(conversationId);
      invalidate([messagingKeys.conversations, messagingKeys.unread]);
      return conversation;
    },
    async create(input: Parameters<MessagingClient["createConversation"]>[0]) {
      const conversation = await client.createConversation(input);
      invalidate([messagingKeys.conversations]);
      return conversation;
    },
  };
}

export function useMessagingActions(): MessagingActions {
  const store = useApiStore();
  return useMemo(
    () =>
      createActions(messagingClient(), (keys) =>
        store.invalidate(keys, { immediate: true }),
      ),
    [store],
  );
}
