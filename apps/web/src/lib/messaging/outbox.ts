import type { Message, UserLite } from "./types";

/**
 * Optimistic sends. A pending message shows at once; it is keyed by
 * `client_msg_id`, so a retry replays the same id and the server returns the
 * original (200) instead of creating a duplicate.
 */
export type PendingSend = {
  client_msg_id: string;
  conversation_id: string;
  parent_message_id: string | null;
  body: string;
  attachment_ids: string[];
  status: "sending" | "failed";
  error?: string;
  /** The server message id once the send succeeded. */
  sent_id?: string;
  created_at: string;
};

export type OptimisticMessage = Message & {
  pending?: { client_msg_id: string; status: "sending" | "failed"; error?: string };
};

export class Outbox {
  private items = new Map<string, PendingSend>();
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  list(conversationId: string, parentId: string | null = null) {
    return [...this.items.values()].filter(
      (item) =>
        item.conversation_id === conversationId &&
        item.parent_message_id === parentId,
    );
  }

  add(item: Omit<PendingSend, "status">) {
    this.items.set(item.client_msg_id, { ...item, status: "sending" });
    this.emit();
  }

  sending(clientMsgId: string) {
    this.update(clientMsgId, { status: "sending", error: undefined });
  }

  failed(clientMsgId: string, error: string) {
    this.update(clientMsgId, { status: "failed", error });
  }

  sent(clientMsgId: string, messageId: string) {
    this.update(clientMsgId, { sent_id: messageId });
  }

  remove(clientMsgId: string) {
    if (this.items.delete(clientMsgId)) this.emit();
  }

  get(clientMsgId: string) {
    return this.items.get(clientMsgId);
  }

  /** Drops sent items the server list already contains. */
  settle(serverIds: ReadonlySet<string>) {
    let changed = false;
    for (const [key, item] of this.items)
      if (item.sent_id && serverIds.has(item.sent_id)) {
        this.items.delete(key);
        changed = true;
      }
    if (changed) this.emit();
  }

  private update(clientMsgId: string, patch: Partial<PendingSend>) {
    const item = this.items.get(clientMsgId);
    if (!item) return;
    this.items.set(clientMsgId, { ...item, ...patch });
    this.emit();
  }

  private emit() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Server messages (ascending by seq) followed by the reader's pending sends.
 * A sent item whose server copy has arrived is hidden, so nothing doubles.
 */
export function withPending(
  server: readonly Message[],
  pending: readonly PendingSend[],
  author: UserLite,
): OptimisticMessage[] {
  const ids = new Set(server.map((message) => message.id));
  const lastSeq = server.at(-1)?.seq ?? 0;
  const optimistic = pending
    .filter((item) => !(item.sent_id && ids.has(item.sent_id)))
    .map(
      (item, index): OptimisticMessage => ({
        id: `pending-${item.client_msg_id}`,
        conversation_id: item.conversation_id,
        seq: lastSeq + index + 0.5,
        author,
        body: item.body,
        parent_message_id: item.parent_message_id,
        reply_count: 0,
        last_reply_at: null,
        attachments: [],
        refs: [],
        mentions_me: false,
        reactions: [],
        links: [],
        edited: false,
        deleted: false,
        created_at: item.created_at,
        pending: {
          client_msg_id: item.client_msg_id,
          status: item.status,
          error: item.error,
        },
      }),
    );
  return [...server, ...optimistic];
}

/** Merges message pages by id and orders them by seq. */
export function mergeMessages(...lists: readonly (readonly Message[])[]) {
  const byId = new Map<string, Message>();
  for (const list of lists) for (const message of list) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}
