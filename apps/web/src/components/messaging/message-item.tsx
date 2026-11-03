"use client";

import { useState } from "react";
import { timeLabel } from "../../lib/messaging/format";
import type { OptimisticMessage } from "../../lib/messaging/outbox";
import {
  bodyToDraft,
  serializeDraft,
  type NameLookup,
} from "../../lib/messaging/tokens";
import type { Message } from "../../lib/messaging/types";
import { useEscape } from "../../lib/messaging/escape";
import { MessageBody } from "./message-body";
import {
  AttachmentList,
  EmojiPicker,
  LinkPreviewCard,
  ReactionsRow,
} from "./message-parts";
import { AiBadge, Avatar, IconButton } from "./primitives";

export type MessageHandlers = {
  onReply?: (message: Message) => void;
  onReact: (message: Message, emoji: string, mine: boolean) => void;
  onEdit: (message: Message, body: string) => Promise<void>;
  onDelete: (message: Message) => void;
  onCopyLink: (message: Message) => void;
  onRetry: (clientMsgId: string) => void;
  onDiscard: (clientMsgId: string) => void;
};

function InlineEditor({
  message,
  lookup,
  onSave,
  onCancel,
}: {
  message: Message;
  lookup: NameLookup;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft] = useState(() => bodyToDraft(message.body, lookup));
  const [text, setText] = useState(draft.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEscape(onCancel);
  async function save() {
    const body = serializeDraft(text, draft.inserts);
    if (!body) return;
    setSaving(true);
    try {
      await onSave(body);
      onCancel();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the edit.");
      setSaving(false);
    }
  }
  return (
    <div className="mt-1 flex flex-col gap-2" data-panel="edit-message">
      <textarea
        aria-label="Edit message"
        value={text}
        autoFocus
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void save();
          }
        }}
        className="w-full resize-none rounded-lg border border-border bg-background p-2 text-sm outline-none focus:border-foreground/40"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background disabled:opacity-50"
        >
          Save
        </button>
        {error ? <span role="alert" className="text-xs text-danger">{error}</span> : null}
      </div>
    </div>
  );
}

export function MessageItem({
  message,
  grouped,
  meId,
  canModerate,
  lookup,
  handlers,
  highlighted,
  inThread,
}: {
  message: OptimisticMessage;
  grouped: boolean;
  meId: string | null;
  canModerate: boolean;
  lookup: NameLookup;
  handlers: MessageHandlers;
  highlighted?: boolean;
  inThread?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mine = message.author.id === meId;
  const pending = message.pending;
  const actionable = !pending && !message.deleted;

  return (
    <article
      id={`message-${message.id}`}
      aria-label={`${message.author.display_name}, ${timeLabel(message.created_at)}`}
      className={`group relative flex gap-3 px-4 hover:bg-surface-secondary ${grouped ? "py-0.5" : "pt-2 pb-0.5"} ${message.mentions_me ? "border-l-2 border-foreground/60" : ""} ${highlighted ? "bg-default-soft" : ""}`}
    >
      <div className="w-9 shrink-0">
        {grouped ? (
          <span className="invisible block pt-0.5 text-right text-[10px] text-muted group-hover:visible">
            {timeLabel(message.created_at)}
          </span>
        ) : (
          <Avatar user={message.author} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped ? (
          <header className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{message.author.display_name}</span>
            {message.author.is_agent ? <AiBadge /> : null}
            <time dateTime={message.created_at} className="text-xs text-muted">
              {timeLabel(message.created_at)}
            </time>
          </header>
        ) : null}
        {message.deleted ? (
          <p className="text-sm italic text-muted">This message was deleted.</p>
        ) : editing ? (
          <InlineEditor
            message={message}
            lookup={lookup}
            onCancel={() => setEditing(false)}
            onSave={(body) => handlers.onEdit(message, body)}
          />
        ) : (
          <div className={`text-sm leading-relaxed ${pending?.status === "sending" ? "text-muted" : ""}`}>
            {message.body ? (
              <MessageBody body={message.body} refs={message.refs} lookup={lookup} meId={meId} />
            ) : null}
            {message.edited ? <span className="ml-1 text-xs text-muted">(edited)</span> : null}
          </div>
        )}
        {!message.deleted ? (
          <>
            <AttachmentList attachments={message.attachments} />
            {message.links.map((link) => (
              <LinkPreviewCard key={link.url} link={link} />
            ))}
            <ReactionsRow
              reactions={message.reactions}
              onToggle={(emoji, wasMine) => handlers.onReact(message, emoji, wasMine)}
            />
          </>
        ) : null}
        {pending ? (
          <p className="mt-0.5 text-xs" role={pending.status === "failed" ? "alert" : "status"}>
            {pending.status === "sending" ? (
              <span className="text-muted">Sending…</span>
            ) : (
              <span className="flex flex-wrap items-center gap-2 text-danger">
                Not sent{pending.error ? `: ${pending.error}` : "."}
                <button type="button" className="font-medium underline" onClick={() => handlers.onRetry(pending.client_msg_id)}>
                  Retry
                </button>
                <button type="button" className="text-muted underline" onClick={() => handlers.onDiscard(pending.client_msg_id)}>
                  Discard
                </button>
              </span>
            )}
          </p>
        ) : null}
        {!inThread && message.reply_count > 0 && handlers.onReply ? (
          <button
            type="button"
            onClick={() => handlers.onReply?.(message)}
            className="mt-1 text-xs font-semibold text-foreground underline-offset-2 hover:underline"
          >
            {message.reply_count === 1 ? "1 reply" : `${message.reply_count} replies`}
          </button>
        ) : null}
        {confirmDelete ? (
          <DeleteConfirm
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => {
              setConfirmDelete(false);
              handlers.onDelete(message);
            }}
          />
        ) : null}
      </div>
      {actionable && !editing ? (
        <div
          role="toolbar"
          aria-label="Message actions"
          className={`absolute -top-3 right-4 z-10 items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5 shadow-sm group-hover:flex group-focus-within:flex ${picking ? "flex" : "hidden"}`}
        >
          {!inThread && handlers.onReply ? (
            <IconButton label="Reply in thread" icon="comment" onClick={() => handlers.onReply?.(message)} />
          ) : null}
          <span className="relative">
            <IconButton label="Add reaction" onClick={() => setPicking((value) => !value)}>
              <span aria-hidden>☺</span>
            </IconButton>
            {picking ? (
              <EmojiPicker
                onClose={() => setPicking(false)}
                onPick={(emoji) => {
                  setPicking(false);
                  const existing = message.reactions.find((item) => item.emoji === emoji);
                  handlers.onReact(message, emoji, existing?.mine ?? false);
                }}
              />
            ) : null}
          </span>
          {mine ? <IconButton label="Edit message" icon="edit" onClick={() => setEditing(true)} /> : null}
          {mine || canModerate ? (
            <IconButton label="Delete message" icon="trash" onClick={() => setConfirmDelete(true)} />
          ) : null}
          <IconButton label="Copy link" icon="attachment" onClick={() => handlers.onCopyLink(message)} />
        </div>
      ) : null}
    </article>
  );
}

function DeleteConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  useEscape(onCancel);
  return (
    <div role="alertdialog" aria-label="Delete message" data-panel="delete-confirm" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2 text-xs">
      <span className="flex-1">Delete this message for everyone?</span>
      <button type="button" onClick={onCancel} className="rounded-md border border-border px-2 py-1 font-medium">
        Cancel
      </button>
      <button type="button" onClick={onConfirm} className="rounded-md bg-danger px-2 py-1 font-medium text-white">
        Delete
      </button>
    </div>
  );
}
