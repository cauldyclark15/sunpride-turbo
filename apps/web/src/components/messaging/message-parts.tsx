"use client";

import { WorkspaceIcon } from "@sunpride/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEscape } from "../../lib/messaging/escape";
import { formatBytes, previewImageSrc } from "../../lib/messaging/format";
import type {
  Attachment,
  LinkPreview,
  Reaction,
} from "../../lib/messaging/types";
import { IconButton, ModalFrame } from "./primitives";

/** One picture in the viewer: a sent attachment, or a file still waiting in the composer. */
export type LightboxImage = {
  key: string;
  src: string;
  name: string;
  downloadUrl?: string | null;
  bytes?: number | null;
};

export function attachmentImages(
  attachments: readonly Attachment[],
): LightboxImage[] {
  return attachments
    .filter((item) => item.kind === "image")
    .map((item) => ({
      key: item.id,
      src: item.url,
      name: item.name,
      downloadUrl: item.url,
      bytes: item.bytes,
    }));
}

/** The next index in a carousel of `count`, wrapping at both ends. */
export function stepIndex(index: number, step: number, count: number) {
  return count ? (((index + step) % count) + count) % count : 0;
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={direction === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
  );
}

/** Full-size pictures with their name and a download link. Several become a carousel:
 * previous/next buttons, the arrow keys, swiping, and a row of thumbnails. */
export function Lightbox({
  images,
  start = 0,
  onClose,
}: {
  images: readonly LightboxImage[];
  start?: number;
  onClose: () => void;
}) {
  const count = images.length;
  const [index, setIndex] = useState(() => stepIndex(start, 0, count));
  const swipe = useRef<number | null>(null);
  const go = useCallback(
    (step: number) => setIndex((current) => stepIndex(current, step, count)),
    [count],
  );
  useEffect(() => {
    if (count < 2) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, go]);
  const image = images[index] ?? images[0];
  if (!image) return null;
  const many = count > 1;
  const navButton =
    "absolute top-1/2 -translate-y-1/2 inline-flex size-10 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 focus-visible:outline-2 focus-visible:outline-white";
  return (
    <ModalFrame title={image.name} onClose={onClose} wide testId="lightbox">
      <div className="flex flex-col items-center gap-3 bg-black/90 p-3">
        <div
          className="relative flex w-full items-center justify-center"
          onTouchStart={(event) => {
            swipe.current = event.touches[0]?.clientX ?? null;
          }}
          onTouchEnd={(event) => {
            const from = swipe.current;
            const to = event.changedTouches[0]?.clientX;
            swipe.current = null;
            if (many && from != null && to != null && Math.abs(to - from) > 40)
              go(to < from ? 1 : -1);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- member-only attachment stream or a local preview. */}
          <img
            key={image.key}
            src={image.src}
            alt={image.name}
            className="max-h-[70dvh] max-w-full select-none object-contain"
            draggable={false}
          />
          {many ? (
            <>
              <button
                type="button"
                aria-label="Previous image"
                onClick={() => go(-1)}
                className={`${navButton} left-1`}
              >
                <Chevron direction="left" />
              </button>
              <button
                type="button"
                aria-label="Next image"
                onClick={() => go(1)}
                className={`${navButton} right-1`}
              >
                <Chevron direction="right" />
              </button>
            </>
          ) : null}
        </div>
        {many ? (
          <>
            <p className="text-xs text-white/80" aria-live="polite">
              {index + 1} of {count}
            </p>
            <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
              {images.map((item, at) => (
                <button
                  key={item.key}
                  type="button"
                  aria-label={`Show image ${at + 1}: ${item.name}`}
                  aria-current={at === index ? "true" : undefined}
                  onClick={() => setIndex(at)}
                  className={`shrink-0 overflow-hidden rounded-md border-2 ${at === index ? "border-white" : "border-transparent opacity-60 hover:opacity-100"}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- member-only attachment stream or a local preview. */}
                  <img src={item.src} alt="" className="size-12 object-cover" />
                </button>
              ))}
            </div>
          </>
        ) : null}
        {image.downloadUrl ? (
          <a
            href={image.downloadUrl}
            download={image.name}
            className="rounded-md border border-white/30 px-3 py-1 text-xs font-medium text-white hover:bg-white/10"
          >
            Download{image.bytes ? ` · ${formatBytes(image.bytes)}` : ""}
          </a>
        ) : null}
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
        <span className="block text-xs text-muted">
          {formatBytes(file.bytes)}
        </span>
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
  const [open, setOpen] = useState<number | null>(null);
  const images = attachments.filter((item) => item.kind === "image");
  const files = attachments.filter((item) => item.kind !== "image");
  if (!attachments.length) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {images.length ? (
        <div className="flex flex-wrap gap-2">
          {images.map((image, at) => (
            <button
              key={image.id}
              type="button"
              aria-label={`Open ${image.name}`}
              onClick={() => setOpen(at)}
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
      {open !== null ? (
        <Lightbox
          images={attachmentImages(images)}
          start={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
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
          <span className="block truncate text-sm font-semibold">
            {link.title}
          </span>
        ) : null}
        {link.description ? (
          <span className="line-clamp-2 block text-xs text-muted">
            {link.description}
          </span>
        ) : null}
      </span>
      {previewImageSrc(link.image_url) ? (
        // eslint-disable-next-line @next/next/no-img-element -- same-origin preview image.
        <img
          src={previewImageSrc(link.image_url) ?? undefined}
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
  "😀",
  "😊",
  "😅",
  "🤔",
  "😮",
  "😢",
  "😡",
  "👏",
  "💪",
  "🙌",
  "👌",
  "✨",
  "⭐",
  "📦",
  "🚚",
  "🛒",
  "💰",
  "📈",
  "📉",
  "📍",
  "⏰",
  "❗",
  "❓",
  "➕",
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
        <span aria-hidden className="text-xs">
          ☺+
        </span>
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
