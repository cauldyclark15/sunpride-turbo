"use client";

import { WorkspaceIcon } from "@sunpride/ui";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import {
  newClientMessageId,
  type MessagingClient,
} from "../../lib/messaging/client";
import { clearDraft, loadDraft, saveDraft } from "../../lib/messaging/drafts";
import { formatBytes } from "../../lib/messaging/format";
import {
  activeTrigger,
  applyTrigger,
  refTitle,
  refToken,
  serializeDraft,
  userToken,
  type DraftInsert,
} from "../../lib/messaging/tokens";
import type { DirectoryUser, RefEntry } from "../../lib/messaging/types";
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS,
  attachmentError,
  isImageMime,
  attachmentMime,
  uploadAttachment,
} from "../../lib/messaging/upload";
import { EmojiPicker, Lightbox, type LightboxImage } from "./message-parts";
import {
  ObjectList,
  PeopleList,
  orderedRefs,
  usePeopleSearch,
  useRefSearch,
} from "./pickers";
import { IconButton } from "./primitives";

export const MAX_BODY_CHARS = 4000;

type UploadItem = {
  key: string;
  file: File;
  progress: number;
  status: "uploading" | "done" | "failed";
  attachmentId?: string;
  error?: string;
  preview?: string;
};

export type ComposerHandle = {
  addFiles: (files: File[]) => void;
  focus: () => void;
};

export type ComposerSend = {
  clientMsgId: string;
  body: string;
  attachmentIds: string[];
};

/** Enter sends, Shift+Enter is a new line; IME composition never sends. */
export function keyIntent(event: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}): "send" | "newline" | null {
  if (event.key !== "Enter" || event.isComposing) return null;
  return event.shiftKey ? "newline" : "send";
}

export function Composer({
  placeholder,
  client,
  onSend,
  allowChannel,
  ref,
  autoFocus,
  draftKey,
}: {
  placeholder: string;
  client: Pick<MessagingClient, "claimAttachment">;
  onSend: (input: ComposerSend) => void;
  allowChannel?: boolean;
  ref?: Ref<ComposerHandle>;
  autoFocus?: boolean;
  /** Where an unsent message is kept on this device (see lib/messaging/drafts). */
  draftKey?: string;
}) {
  // What was typed here last time. The composer only mounts in the browser (after the
  // conversation loads), and is keyed per conversation/thread, so reading storage here is safe.
  const [saved] = useState(() => (draftKey ? loadDraft(draftKey) : null));
  const [text, setText] = useState(saved?.text ?? "");
  const [inserts, setInserts] = useState<DraftInsert[]>(saved?.inserts ?? []);
  const [caret, setCaret] = useState(saved?.text.length ?? 0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  const [emoji, setEmoji] = useState(false);
  const [error, setError] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Keep saving what they type, so leaving and coming back loses nothing.
  useEffect(() => {
    if (draftKey) saveDraft(draftKey, text, inserts);
  }, [draftKey, text, inserts]);
  const fileInput = useRef<HTMLInputElement>(null);

  const trigger = activeTrigger(text, caret);
  const open = trigger && trigger.start !== dismissedAt ? trigger : null;
  const people = usePeopleSearch(open?.trigger === "@" ? open.query : null);
  const refs = useRefSearch(open?.trigger === "#" ? open.query : null);
  const peopleItems = people.data ?? [];
  const showChannel =
    Boolean(allowChannel) &&
    open?.trigger === "@" &&
    "channel".startsWith(open.query.toLowerCase());
  const refItems = orderedRefs(refs.data ?? []);
  const optionCount =
    open?.trigger === "@"
      ? peopleItems.length + (showChannel ? 1 : 0)
      : refItems.length;

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [text]);

  const uploadsRef = useRef<UploadItem[]>([]);
  useEffect(() => {
    uploadsRef.current = uploads;
  });
  useEffect(
    () => () => {
      for (const item of uploadsRef.current)
        if (item.preview) URL.revokeObjectURL(item.preview);
    },
    [],
  );

  function patchUpload(key: string, patch: Partial<UploadItem>) {
    setUploads((list) =>
      list.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  function startUpload(item: UploadItem) {
    patchUpload(item.key, {
      status: "uploading",
      progress: 0,
      error: undefined,
    });
    uploadAttachment(
      item.file,
      (progress) => patchUpload(item.key, { progress }),
      { client },
    ).then(
      (attachmentId) =>
        patchUpload(item.key, { status: "done", attachmentId, progress: 1 }),
      (reason: unknown) =>
        patchUpload(item.key, {
          status: "failed",
          error: reason instanceof Error ? reason.message : "Upload failed.",
        }),
    );
  }

  function addFiles(files: File[]) {
    setError("");
    const room = MAX_ATTACHMENTS - uploadsRef.current.length;
    if (files.length > room)
      setError("You can attach up to 10 files to one message.");
    const accepted: UploadItem[] = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      const problem = attachmentError(file);
      if (problem) {
        setError(problem);
        continue;
      }
      accepted.push({
        key: newClientMessageId(),
        file,
        progress: 0,
        status: "uploading",
        preview:
          isImageMime(attachmentMime(file)) &&
          typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(file)
            : undefined,
      });
    }
    if (!accepted.length) return;
    setUploads((list) => [...list, ...accepted]);
    for (const item of accepted) startUpload(item);
  }

  useImperativeHandle(ref, () => ({
    addFiles,
    focus: () => textarea.current?.focus(),
  }));

  function removeUpload(key: string) {
    setUploads((list) => {
      const item = list.find((entry) => entry.key === key);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return list.filter((entry) => entry.key !== key);
    });
  }

  function insertAtCaret(value: string) {
    const element = textarea.current;
    const start = element?.selectionStart ?? text.length;
    const end = element?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + value + text.slice(end);
    setText(next);
    const position = start + value.length;
    setCaret(position);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(position, position);
    });
  }

  function pick(label: string, token: string | null) {
    if (!open) return;
    const result = applyTrigger(text, caret, open.start, label);
    setText(result.text);
    setCaret(result.caret);
    if (token) setInserts((list) => [...list, { label, token }]);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(result.caret, result.caret);
    });
  }

  function pickPerson(person: DirectoryUser | "channel") {
    if (person === "channel") pick("@channel", null);
    else pick(`@${person.display_name}`, userToken(person.id));
  }

  function pickRef(entry: RefEntry) {
    pick(`#${refTitle(entry)}`, refToken(entry.type, entry.id));
  }

  const uploading = uploads.some((item) => item.status === "uploading");
  const failed = uploads.some((item) => item.status === "failed");

  function submit() {
    const body = serializeDraft(text, inserts);
    const attachmentIds = uploads.flatMap((item) =>
      item.status === "done" && item.attachmentId ? [item.attachmentId] : [],
    );
    if (!body && !attachmentIds.length) return;
    if (uploading) {
      setError("Wait for the files to finish uploading.");
      return;
    }
    if (failed) {
      setError("Some files did not upload. Retry or remove them.");
      return;
    }
    if (body.length > MAX_BODY_CHARS) {
      setError("Messages can be up to 4,000 characters.");
      return;
    }
    onSend({ clientMsgId: newClientMessageId(), body, attachmentIds });
    for (const item of uploads)
      if (item.preview) URL.revokeObjectURL(item.preview);
    if (draftKey) clearDraft(draftKey);
    setText("");
    setInserts([]);
    setUploads([]);
    setCaret(0);
    setError("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && optionCount > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (index + step + optionCount) % optionCount);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const index = Math.min(activeIndex, optionCount - 1);
        if (open.trigger === "@") {
          const person = peopleItems[index];
          pickPerson(person ?? "channel");
        } else {
          const entry = refItems[index];
          if (entry) pickRef(entry);
        }
        return;
      }
    }
    if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissedAt(open.start);
      return;
    }
    if (keyIntent(event.nativeEvent) === "send") {
      event.preventDefault();
      submit();
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length) {
      event.preventDefault();
      addFiles(files);
    }
  }

  const gallery: LightboxImage[] = uploads.flatMap((item) =>
    item.preview
      ? [
          {
            key: item.key,
            src: item.preview,
            name: item.file.name,
            bytes: item.file.size,
          },
        ]
      : [],
  );

  return (
    <div className="relative border-t border-separator bg-surface px-3 pb-3 pt-2 sm:px-4">
      {open?.trigger === "@" ? (
        <PeopleList
          people={peopleItems}
          activeIndex={activeIndex}
          onPick={pickPerson}
          loading={people.isLoading}
          includeChannel={showChannel}
        />
      ) : null}
      {open?.trigger === "#" ? (
        <ObjectList
          entries={refs.data ?? []}
          activeIndex={activeIndex}
          onPick={pickRef}
          loading={refs.isLoading}
        />
      ) : null}
      {uploads.length ? (
        <ul aria-label="Attachments" className="mb-2 flex flex-wrap gap-2">
          {uploads.map((item) => (
            <li
              key={item.key}
              className="relative flex w-56 items-center gap-2 rounded-xl border border-border p-2"
            >
              {item.preview ? (
                <button
                  type="button"
                  aria-label={`Preview ${item.file.name}`}
                  onClick={() =>
                    setViewing(
                      gallery.findIndex((entry) => entry.key === item.key),
                    )
                  }
                  className="shrink-0 overflow-hidden rounded-md focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview. */}
                  <img
                    src={item.preview}
                    alt=""
                    className="size-9 object-cover"
                  />
                </button>
              ) : (
                <span
                  aria-hidden
                  className="inline-flex size-9 items-center justify-center rounded-md bg-default-soft text-muted"
                >
                  <WorkspaceIcon name="document" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">
                  {item.file.name}
                </span>
                {item.status === "failed" ? (
                  <button
                    type="button"
                    className="text-xs text-danger underline"
                    onClick={() => startUpload(item)}
                  >
                    Upload failed. Retry
                  </button>
                ) : item.status === "uploading" ? (
                  <span
                    role="progressbar"
                    aria-label={`Uploading ${item.file.name}`}
                    aria-valuenow={Math.round(item.progress * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="mt-1 block h-1 overflow-hidden rounded bg-default-soft"
                  >
                    <span
                      className="block h-full bg-foreground transition-[width]"
                      style={{ width: `${Math.round(item.progress * 100)}%` }}
                    />
                  </span>
                ) : (
                  <span className="block text-xs text-muted">
                    {formatBytes(item.file.size)}
                  </span>
                )}
              </span>
              <IconButton
                label={`Remove ${item.file.name}`}
                icon="close"
                className="size-6"
                onClick={() => removeUpload(item.key)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-1 rounded-xl border border-border bg-background px-2 py-1.5 focus-within:border-foreground/40">
        <IconButton
          label="Attach files"
          icon="attachment"
          onClick={() => fileInput.current?.click()}
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept={ATTACHMENT_ACCEPT}
          aria-label="Choose files to attach"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <textarea
          ref={textarea}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          aria-label={placeholder}
          placeholder={placeholder}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setActiveIndex(0);
          }}
          onSelect={(event) =>
            setCaret(event.currentTarget.selectionStart ?? text.length)
          }
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="max-h-56 min-h-8 flex-1 resize-none border-0 bg-transparent px-1 py-1 text-sm shadow-none outline-none ring-0 placeholder:text-muted focus:ring-0"
        />
        <span className="relative">
          <IconButton
            label="Add emoji"
            onClick={() => setEmoji((value) => !value)}
          >
            <span aria-hidden className="text-base">
              ☺
            </span>
          </IconButton>
          {emoji ? (
            <EmojiPicker
              label="Add emoji"
              onClose={() => setEmoji(false)}
              onPick={(value) => {
                setEmoji(false);
                insertAtCaret(value);
              }}
            />
          ) : null}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={uploading}
          className="h-8 rounded-lg bg-foreground px-3 text-sm font-medium text-background disabled:opacity-50"
        >
          Send
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : (
        <p className="mt-1 hidden text-[11px] text-muted sm:block">
          Enter to send · Shift+Enter for a new line · @ to mention · # to tag
          an item
        </p>
      )}
      {viewing !== null && viewing >= 0 && gallery.length ? (
        <Lightbox
          images={gallery}
          start={viewing}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
}
