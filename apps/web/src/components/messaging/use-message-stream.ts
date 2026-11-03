"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { messagingClient } from "../../lib/messaging/client";
import { useLatestMessages } from "../../lib/messaging/hooks";
import {
  mergeMessages,
  withPending,
  type OptimisticMessage,
  type Outbox,
} from "../../lib/messaging/outbox";
import type { Message, UserLite } from "../../lib/messaging/types";

type Older = { key: string; items: Message[]; hasMore: boolean | null };

/**
 * Top-level messages of a conversation, or a thread's replies: the live
 * latest page, older pages loaded on scroll, and the reader's pending sends.
 */
export function useMessageStream(
  conversationId: string | null,
  threadId: string | null,
  outbox: Outbox,
  me: UserLite,
) {
  const latest = useLatestMessages(conversationId, threadId);
  const streamKey = `${conversationId ?? ""}/${threadId ?? ""}`;
  const [older, setOlder] = useState<Older>({ key: streamKey, items: [], hasMore: null });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const current = older.key === streamKey ? older : { key: streamKey, items: [], hasMore: null };

  useSyncExternalStore(outbox.subscribe, outbox.getVersion, outbox.getVersion);
  const pending = conversationId ? outbox.list(conversationId, threadId) : [];

  const server = useMemo(
    () => mergeMessages(current.items, latest.data?.items ?? []),
    [current.items, latest.data],
  );
  useEffect(() => {
    outbox.settle(new Set(server.map((message) => message.id)));
  }, [outbox, server]);

  const hasMore = current.hasMore ?? latest.data?.has_more ?? false;

  const loadOlder = useCallback(async () => {
    const oldest = server[0];
    if (!conversationId || !oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await messagingClient().listMessages(conversationId, {
        before_seq: oldest.seq,
        limit: 50,
        thread: threadId ?? undefined,
      });
      setOlder((previous) => ({
        key: streamKey,
        items: mergeMessages(previous.key === streamKey ? previous.items : [], page.items),
        hasMore: page.has_more,
      }));
    } finally {
      setLoadingOlder(false);
    }
  }, [server, conversationId, threadId, streamKey, loadingOlder]);

  const messages: OptimisticMessage[] = withPending(server, pending, me);
  return {
    messages,
    hasMore,
    loadOlder,
    loadingOlder,
    isLoading: latest.isLoading,
    error: latest.error,
    refetch: latest.refetch,
  };
}
