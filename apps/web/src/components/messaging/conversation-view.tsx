"use client";

import { WorkspaceIcon } from "@sunpride/ui";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { draftKey } from "../../lib/messaging/drafts";
import {
  buildTimeline,
  conversationTitle,
  otherMembers,
} from "../../lib/messaging/format";
import { useConversation } from "../../lib/messaging/hooks";
import type { NameLookup } from "../../lib/messaging/tokens";
import type {
  Conversation,
  ConversationDetail,
  Message,
  UserLite,
} from "../../lib/messaging/types";
import type { MessagingActions } from "./actions";
import { Composer, type ComposerHandle } from "./composer";
import { MessageItem, type MessageHandlers } from "./message-item";
import { MessageList } from "./message-list";
import { DeveloperBadge, IconButton, SidePanel, Spinner } from "./primitives";
import { useMessageStream } from "./use-message-stream";

/** Names for mention chips: resolved user refs, then members, then authors. */
export function buildLookup(
  detail: ConversationDetail | undefined,
  messages: readonly Message[],
): NameLookup {
  const names = new Map<string, string>();
  for (const member of detail?.members ?? [])
    names.set(member.id, member.display_name);
  for (const member of detail?.members_preview ?? [])
    names.set(member.id, member.display_name);
  for (const message of messages) {
    names.set(message.author.id, message.author.display_name);
    for (const ref of message.refs)
      if (ref.type === "user" && ref.access === "ok")
        names.set(ref.id, ref.title);
  }
  const refs = messages.flatMap((message) => message.refs);
  return {
    user: (id) => names.get(id),
    ref: (type, id) => refs.find((ref) => ref.type === type && ref.id === id),
  };
}

export function messageLink(
  origin: string,
  message: Pick<Message, "id" | "conversation_id">,
) {
  return `${origin}/messages?c=${encodeURIComponent(message.conversation_id)}&m=${encodeURIComponent(message.id)}`;
}

function useHandlers(
  actions: MessagingActions,
  notify: (text: string) => void,
  onReply?: (message: Message) => void,
): MessageHandlers {
  return {
    onReply,
    onReact: (message, emoji, mine) => {
      actions
        .react(message, emoji, mine)
        .catch(() => notify("Could not update the reaction."));
    },
    onEdit: (message, body) => actions.edit(message, body),
    onDelete: (message) => {
      actions
        .remove(message)
        .catch(() => notify("Could not delete the message."));
    },
    onCopyLink: (message) => {
      const url = messageLink(window.location.origin, message);
      void navigator.clipboard?.writeText(url).then(
        () => notify("Link copied."),
        () => notify("Could not copy the link."),
      );
    },
    onRetry: (id) => void actions.retry(id),
    onDiscard: (id) => actions.discard(id),
  };
}

function useNotice() {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice] as const;
}

function filesFrom(event: DragEvent) {
  return Array.from(event.dataTransfer?.files ?? []);
}

export function ConversationView({
  conversation,
  me,
  canModerate,
  actions,
  focusMessageId,
  onBack,
  onOpenThread,
  onOpenDetails,
  onOpenSearch,
}: {
  conversation: Conversation;
  me: UserLite;
  canModerate: boolean;
  actions: MessagingActions;
  focusMessageId: string | null;
  onBack: () => void;
  onOpenThread: (message: Message) => void;
  onOpenDetails: () => void;
  onOpenSearch: () => void;
}) {
  const detail = useConversation(conversation.id).data;
  const stream = useMessageStream(conversation.id, null, actions.outbox, me);
  const composer = useRef<ComposerHandle>(null);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useNotice();
  const handlers = useHandlers(actions, setNotice, onOpenThread);

  const serverMessages = stream.messages.filter(
    (message) => !("pending" in message && message.pending),
  );
  const latestSeq = serverMessages.at(-1)?.seq ?? 0;
  const myLastRead = detail?.members.find(
    (member) => member.id === me.id,
  )?.last_read_seq;

  // Freeze where the reader stopped when the conversation opened, so the
  // "New" divider stays put after the read marker moves.
  const [frozen, setFrozen] = useState<{ id: string; seq: number } | null>(
    null,
  );
  const opening =
    frozen?.id !== conversation.id &&
    (myLastRead !== undefined ||
      (stream.messages.length > 0 && conversation.unread_count === 0));
  if (opening)
    setFrozen({
      id: conversation.id,
      seq: myLastRead ?? Math.max(0, latestSeq - conversation.unread_count),
    });
  const lastReadSeq = frozen?.id === conversation.id ? frozen.seq : null;

  const read = useRef<{ id: string; seq: number }>({ id: "", seq: 0 });
  useEffect(() => {
    if (!latestSeq) return;
    if (read.current.id === conversation.id && read.current.seq >= latestSeq)
      return;
    if (
      myLastRead !== undefined &&
      myLastRead >= latestSeq &&
      conversation.unread_count === 0
    )
      return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    )
      return;
    read.current = { id: conversation.id, seq: latestSeq };
    actions.markRead(conversation.id, latestSeq).catch(() => {
      read.current = { id: "", seq: 0 };
    });
  }, [
    actions,
    conversation.id,
    conversation.unread_count,
    latestSeq,
    myLastRead,
  ]);

  const lookup = useMemo(
    () => buildLookup(detail, serverMessages),
    [detail, serverMessages],
  );
  const timeline = buildTimeline(stream.messages, { lastReadSeq, meId: me.id });
  const title = conversationTitle(conversation, me.id);
  const agent =
    conversation.kind === "dm" &&
    otherMembers(conversation, me.id).some((m) => m.is_agent);

  return (
    <section
      aria-label={title}
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
      onDragOver={(event) => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return;
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const files = filesFrom(event);
        if (files.length) composer.current?.addFiles(files);
      }}
    >
      <header className="flex min-h-14 items-center gap-2 border-b border-separator bg-surface px-2 sm:px-4">
        <IconButton
          label="Back to conversations"
          icon="back"
          className="md:hidden"
          onClick={onBack}
        />
        <button
          type="button"
          onClick={onOpenDetails}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-center gap-1.5">
            {conversation.kind === "channel" ? (
              <span aria-hidden className="text-muted">
                {conversation.is_private ? "🔒" : "#"}
              </span>
            ) : null}
            <span className="truncate text-sm font-semibold">{title}</span>
            {agent ? <DeveloperBadge /> : null}
          </span>
          {conversation.topic ? (
            <span className="block truncate text-xs text-muted">
              {conversation.topic}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={onOpenDetails}
          className="hidden items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-default-soft sm:inline-flex"
        >
          <WorkspaceIcon name="user" className="size-3.5" />
          {conversation.member_count}
          <span className="sr-only"> members</span>
        </button>
        <IconButton
          label="Search messages"
          icon="search"
          onClick={onOpenSearch}
        />
        <IconButton
          label="Conversation details"
          icon="more"
          onClick={onOpenDetails}
        />
      </header>
      {stream.isLoading ? (
        <Spinner label="Loading messages…" />
      ) : stream.error && !stream.messages.length ? (
        <p role="alert" className="p-4 text-sm text-danger">
          Messages could not be loaded. {stream.error.message}
        </p>
      ) : (
        <MessageList
          items={timeline}
          hasMore={stream.hasMore}
          loadingOlder={stream.loadingOlder}
          onLoadOlder={() => void stream.loadOlder()}
          focusId={focusMessageId}
          emptyText={
            conversation.kind === "channel"
              ? `This is the beginning of #${title}. Say hello.`
              : `This is the beginning of your conversation with ${title}.`
          }
          renderMessage={(item) => (
            <MessageItem
              message={item.message}
              grouped={item.grouped}
              meId={me.id}
              canModerate={canModerate}
              lookup={lookup}
              handlers={handlers}
              highlighted={item.message.id === focusMessageId}
            />
          )}
        />
      )}
      <Composer
        key={conversation.id}
        draftKey={draftKey(me.id, conversation.id)}
        ref={composer}
        placeholder={
          conversation.kind === "channel"
            ? `Message #${title}`
            : `Message ${title}`
        }
        client={actions.client}
        allowChannel={conversation.kind !== "dm"}
        autoFocus
        onSend={(input) =>
          void actions.send({
            conversationId: conversation.id,
            clientMsgId: input.clientMsgId,
            body: input.body,
            attachmentIds: input.attachmentIds,
          })
        }
      />
      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-foreground/40 bg-surface/90 text-sm font-medium">
          Drop files to attach them
        </div>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="absolute bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-full bg-foreground px-3 py-1 text-xs text-background"
        >
          {notice}
        </p>
      ) : null}
    </section>
  );
}

export function ThreadPanel({
  conversation,
  parent,
  me,
  canModerate,
  actions,
  onClose,
}: {
  conversation: Conversation;
  parent: Message;
  me: UserLite;
  canModerate: boolean;
  actions: MessagingActions;
  onClose: () => void;
}) {
  const detail = useConversation(conversation.id).data;
  const stream = useMessageStream(
    conversation.id,
    parent.id,
    actions.outbox,
    me,
  );
  const replies = stream.messages.filter((message) => message.id !== parent.id);
  const [notice, setNotice] = useNotice();
  const handlers = useHandlers(actions, setNotice);
  const lookup = useMemo(
    () => buildLookup(detail, [parent, ...replies]),
    [detail, parent, replies],
  );
  const timeline = buildTimeline(replies, { meId: me.id });
  return (
    <SidePanel
      title="Thread"
      subtitle={conversationTitle(conversation, me.id)}
      onClose={onClose}
      testId="thread"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-separator py-2">
          <MessageItem
            message={parent}
            grouped={false}
            meId={me.id}
            canModerate={canModerate}
            lookup={lookup}
            handlers={handlers}
            inThread
          />
        </div>
        {stream.isLoading ? (
          <Spinner label="Loading replies…" />
        ) : (
          <MessageList
            items={timeline}
            hasMore={stream.hasMore}
            loadingOlder={stream.loadingOlder}
            onLoadOlder={() => void stream.loadOlder()}
            emptyText="No replies yet."
            startText={null}
            renderMessage={(item) => (
              <MessageItem
                message={item.message}
                grouped={item.grouped}
                meId={me.id}
                canModerate={canModerate}
                lookup={lookup}
                handlers={handlers}
                inThread
              />
            )}
          />
        )}
        <Composer
          key={parent.id}
          draftKey={draftKey(me.id, conversation.id, parent.id)}
          placeholder="Reply in thread"
          client={actions.client}
          allowChannel={false}
          onSend={(input) =>
            void actions.send({
              conversationId: conversation.id,
              clientMsgId: input.clientMsgId,
              body: input.body,
              parentId: parent.id,
              attachmentIds: input.attachmentIds,
            })
          }
        />
        {notice ? (
          <p role="status" className="px-4 pb-2 text-xs text-muted">
            {notice}
          </p>
        ) : null}
      </div>
    </SidePanel>
  );
}
