"use client";

import { WorkspaceIcon } from "@sunpride/ui";
import { useState } from "react";
import { useEscape } from "../../lib/messaging/escape";
import { formatBytes } from "../../lib/messaging/format";
import type { Attachment, LinkPreview, Reaction } from "../../lib/messaging/types";
import { IconButton, ModalFrame } from "./primitives";

/** Full-size image with its name and a download link. */
export function Lightbox({
  image,
  onClose,
}: {
  image: Attachment;
  onClose: () => void;
}) {
  return (
    <ModalFrame title={image.name} onClose={onClose} wide testId="lightbox">
      <div className="flex flex-col items-center gap-3 bg-black/90 p-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- member-only attachment stream. */}
        <img
          src={image.url}
          alt={image.name}
          className="max-h-[70dvh] max-w-full object-contain"
        />
        <a
          href={image.url}
          download={image.name}
          className="rounded-md border border-white/30 px-3 py-1 text-xs font-medium text-white hover:bg-white/10"
        >
          Download · {formatBytes(image.bytes)}
        </a>
      </div>
    </ModalFrame>
  );
}

function fileIconLabel(attachment: Attachment) {
  const ext = attachment.name.split(".").pop()?.toUpperCase() ?? "";
  return ext.length <= 4 ? ext : "FILE";
}

export function FileCard({ file }: { file: Attachment }) {
  return (
    <a
      href={file.url}
      download={file.name}
      className="flex w-full max-w-sm items-center gap-3 rounded-xl border border-border bg-surface p-2.5 hover:bg-surface-secondary"
    >
      <span
        aria-hidden
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-default-soft text-[10px] font-semibold text-muted"
      >
        {fileIconLabel(file)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{file.name}</span>
        <span className="block text-xs text-muted">{formatBytes(file.bytes)}</span>
      </span>
      <span className="text-muted" aria-label={`Download ${file.name}`}>
        <WorkspaceIcon name="document" />
      </span>
    </a>
  );
}

export function AttachmentList({
  attachments,
}: {
  attachments: readonly Attachment[];
}) {
  const [open, setOpen] = useState<Attachment | null>(null);
  const images = attachments.filter((item) => item.kind === "image");
  const files = attachments.filter((item) => item.kind !== "image");
  if (!attachments.length) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {images.length ? (
        <div className="flex flex-wrap gap-2">
          {images.map((image) => (
            <button
              key={image.id}
              type="button"
              aria-label={`Open ${image.name}`}
              onClick={() => setOpen(image)}
              className="overflow-hidden rounded-xl border border-border"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- member-only attachment stream. */}
              <img
                src={image.thumb_url ?? image.url}
                alt={image.name}
                loading="lazy"
                width={image.width ?? undefined}
                height={image.height ?? undefined}
                className="h-40 w-auto max-w-72 object-cover"
              />
            </button>
          ))}
        </div>
      ) : null}
      {files.map((file) => (
        <FileCard key={file.id} file={file} />
      ))}
      {open ? <Lightbox image={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

export function LinkPreviewCard({ link }: { link: LinkPreview }) {
  if (!link.title && !link.description) return null;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 flex max-w-md gap-3 rounded-xl border border-border border-l-4 bg-surface p-2.5 hover:bg-surface-secondary"
    >
      <span className="min-w-0 flex-1">
        {link.site_name ? (
          <span className="block text-xs text-muted">{link.site_name}</span>
        ) : null}
        {link.title ? (
          <span className="block truncate text-sm font-semibold">{link.title}</span>
        ) : null}
        {link.description ? (
          <span className="line-clamp-2 block text-xs text-muted">
            {link.description}
          </span>
        ) : null}
      </span>
      {link.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote preview image.
        <img
          src={link.image_url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-16 shrink-0 rounded-lg object-cover"
        />
      ) : null}
    </a>
  );
}

export const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉", "🙏", "👀", "✅", "🔥"];
export const EMOJI = [
  ...QUICK_EMOJI,
  "😀", "😊", "😅", "🤔", "😮", "😢", "😡", "👏",
  "💪", "🙌", "👌", "✨", "⭐", "📦", "🚚", "🛒",
  "💰", "📈", "📉", "📍", "⏰", "❗", "❓", "➕",
];

export function EmojiPicker({
  onPick,
  onClose,
  label = "Add reaction",
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  label?: string;
}) {
  useEscape(onClose);
  return (
    <div
      role="dialog"
      aria-label={label}
      data-panel="emoji-picker"
      className="absolute bottom-full right-0 z-40 mb-1 w-64 rounded-xl border border-border bg-surface p-2 shadow-lg"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted">{label}</span>
        <IconButton label="Close emoji picker" icon="close" onClick={onClose} />
      </div>
      <div className="grid grid-cols-8 gap-1">
        {EMOJI.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={`React with ${emoji}`}
            onClick={() => onPick(emoji)}
            className="rounded-md p-1 text-lg hover:bg-default-soft"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReactionsRow({
  reactions,
  onToggle,
}: {
  reactions: readonly Reaction[];
  onToggle: (emoji: string, mine: boolean) => void;
}) {
  const [picking, setPicking] = useState(false);
  if (!reactions.length) return null;
  return (
    <div className="relative mt-1 flex flex-wrap items-center gap-1">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          aria-pressed={reaction.mine}
          aria-label={`${reaction.emoji} ${reaction.count} ${reaction.count === 1 ? "reaction" : "reactions"}${reaction.mine ? ", including yours" : ""}`}
          onClick={() => onToggle(reaction.emoji, reaction.mine)}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-px text-xs ${reaction.mine ? "border-foreground/40 bg-default-soft" : "border-border bg-surface hover:bg-default-soft"}`}
        >
          <span>{reaction.emoji}</span>
          <span className="font-medium">{reaction.count}</span>
        </button>
      ))}
      <IconButton
        label="Add reaction"
        className="size-6 rounded-full border border-border"
        onClick={() => setPicking(true)}
      >
        <span aria-hidden className="text-xs">☺+</span>
      </IconButton>
      {picking ? (
        <EmojiPicker
          onClose={() => setPicking(false)}
          onPick={(emoji) => {
            setPicking(false);
            const existing = reactions.find((item) => item.emoji === emoji);
            onToggle(emoji, existing?.mine ?? false);
          }}
        />
      ) : null}
    </div>
  );
}
