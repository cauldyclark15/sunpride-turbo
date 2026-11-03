"use client";

import { useState } from "react";
import { useEscape } from "../../lib/messaging/escape";
import { parseBody, refTitle, type NameLookup } from "../../lib/messaging/tokens";
import type { RefEntry, RefType } from "../../lib/messaging/types";
import { IconButton, REF_TYPE_LABELS, REF_TYPE_SINGULAR, RefTypeIcon } from "./primitives";

/** The card a ref chip opens: title, subtitle and a link to the item. */
export function RefCard({
  entry,
  type,
  onClose,
}: {
  entry: RefEntry | undefined;
  type: RefType;
  onClose: () => void;
}) {
  useEscape(onClose);
  const open = entry?.access === "ok";
  return (
    <span
      role="dialog"
      aria-label={refTitle(entry)}
      data-panel="ref-card"
      className="absolute left-0 top-full z-40 mt-1 flex w-72 flex-col gap-2 rounded-xl border border-border bg-surface p-3 text-left text-sm shadow-lg"
    >
      <span className="flex items-start gap-3">
        <RefThumb entry={entry} type={type} large />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{refTitle(entry)}</span>
          <span className="block text-xs text-muted">
            {open
              ? (entry.subtitle ?? REF_TYPE_LABELS[type])
              : entry?.access === "missing"
                ? "This item no longer exists."
                : "You don't have access to this item."}
          </span>
        </span>
        <IconButton label="Close item card" icon="close" onClick={onClose} />
      </span>
      {open ? (
        <a
          href={entry.href}
          className="self-start rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-default-soft"
        >
          Open {REF_TYPE_SINGULAR[type]}
        </a>
      ) : null}
    </span>
  );
}

function RefThumb({
  entry,
  type,
  large,
}: {
  entry: RefEntry | undefined;
  type: RefType;
  large?: boolean;
}) {
  const box = large ? "size-10 rounded-lg" : "size-4 rounded-sm";
  const [broken, setBroken] = useState(false);
  if (entry?.access === "ok" && entry.thumb_url && !broken)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- authenticated media URLs.
      <img src={entry.thumb_url} alt="" onError={() => setBroken(true)} className={`${box} shrink-0 object-cover`} />
    );
  return (
    <span
      aria-hidden
      className={`${box} inline-flex shrink-0 items-center justify-center bg-default-soft text-muted`}
    >
      <RefTypeIcon type={type} className={large ? "size-5" : "size-3"} />
    </span>
  );
}

/** `#object` chip: thumbnail (or type icon) and title; click or hover opens its card. */
export function RefChip({
  entry,
  type,
}: {
  entry: RefEntry | undefined;
  type: RefType;
}) {
  const [open, setOpen] = useState(false);
  const restricted = entry?.access !== "ok";
  return (
    <span
      className="relative inline-flex align-baseline"
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setOpen(true)}
        className={`inline-flex max-w-64 items-center gap-1 rounded-md border border-border px-1.5 py-px text-[13px] font-medium ${restricted ? "text-muted italic" : "bg-default-soft hover:bg-surface-secondary"}`}
      >
        <RefThumb entry={entry} type={type} />
        <span className="truncate">{refTitle(entry)}</span>
      </button>
      {open ? (
        <RefCard entry={entry} type={type} onClose={() => setOpen(false)} />
      ) : null}
    </span>
  );
}

export function MessageBody({
  body,
  refs,
  lookup,
  meId,
}: {
  body: string;
  refs: readonly RefEntry[];
  lookup: NameLookup;
  meId?: string | null;
}) {
  const findRef = (type: RefType, id: string) =>
    refs.find((ref) => ref.type === type && ref.id === id) ??
    lookup.ref(type, id);
  return (
    <span className="whitespace-pre-wrap break-words">
      {parseBody(body).map((segment, index) => {
        switch (segment.kind) {
          case "text":
            return <span key={index}>{segment.text}</span>;
          case "user": {
            const name =
              findRef("user", segment.id)?.title ??
              lookup.user(segment.id) ??
              "someone";
            return (
              <span
                key={index}
                className={`rounded px-0.5 font-semibold ${segment.id === meId ? "bg-default-soft text-foreground ring-1 ring-foreground/20" : "text-foreground"}`}
              >
                @{name}
              </span>
            );
          }
          case "channel":
            return (
              <span key={index} className="rounded bg-default-soft px-0.5 font-semibold text-foreground">
                @channel
              </span>
            );
          case "ref":
            return (
              <RefChip
                key={index}
                type={segment.type}
                entry={findRef(segment.type, segment.id)}
              />
            );
          case "link":
            return (
              <a
                key={index}
                href={segment.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-foreground/40 underline-offset-2 hover:decoration-foreground"
              >
                {segment.url}
              </a>
            );
        }
      })}
    </span>
  );
}
