"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TimelineItem } from "../../lib/messaging/format";

const NEAR_BOTTOM_PX = 80;
const NEAR_TOP_PX = 120;

/**
 * Scrolling message list: day separators and the "New" divider come from
 * the timeline; scrolling to the top loads older messages without jumping,
 * new messages keep you at the bottom, and "Jump to latest" appears when you
 * have scrolled up.
 */
export function MessageList({
  items,
  hasMore,
  loadingOlder,
  onLoadOlder,
  renderMessage,
  focusId,
  emptyText,
  startText = "This is the start of the conversation.",
}: {
  items: readonly TimelineItem[];
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  renderMessage: (item: Extract<TimelineItem, { kind: "message" }>) => ReactNode;
  focusId?: string | null;
  emptyText: string;
  startText?: string | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const first = useRef<string | null>(null);
  const last = useRef<string | null>(null);
  const height = useRef(0);
  const placed = useRef(false);

  const firstKey = items.find((item) => item.kind === "message")?.key ?? null;
  const lastKey =
    [...items].reverse().find((item) => item.kind === "message")?.key ?? null;

  // The newest message the reader has seen at the bottom of the list.
  const [seenKey, setSeenKey] = useState(lastKey);
  const unseen = lastKey !== seenKey;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (!placed.current && lastKey) {
      // First paint: the linked message, else the New divider, else the bottom.
      const target =
        (focusId && element.querySelector(`#message-${CSS.escape(focusId)}`)) ||
        element.querySelector("[data-new-divider]");
      if (target instanceof HTMLElement)
        element.scrollTop = Math.max(0, target.offsetTop - 48);
      else element.scrollTop = element.scrollHeight;
      placed.current = true;
    } else if (first.current && firstKey !== first.current && lastKey === last.current) {
      // Older page prepended: keep what the reader was looking at in place.
      element.scrollTop += element.scrollHeight - height.current;
    } else if (lastKey !== last.current && last.current !== null) {
      // Staying at the bottom follows new messages; otherwise the jump
      // button says there is something new.
      if (atBottom) element.scrollTop = element.scrollHeight;
    }
    first.current = firstKey;
    last.current = lastKey;
    height.current = element.scrollHeight;
  }, [firstKey, lastKey, focusId, atBottom]);

  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    height.current = element.scrollHeight;
    const bottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (bottom !== atBottom) setAtBottom(bottom);
    if (bottom && seenKey !== lastKey) setSeenKey(lastKey);
    if (element.scrollTop < NEAR_TOP_PX && hasMore && !loadingOlder) onLoadOlder();
  }

  function jumpToLatest() {
    const element = scroller.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setSeenKey(lastKey);
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-label="Messages"
        aria-live="polite"
        className="relative h-full overflow-y-auto pb-3"
      >
        {hasMore ? (
          <div className="flex justify-center py-3">
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={loadingOlder}
              className="rounded-md px-2 py-1 text-xs text-muted hover:bg-default-soft"
            >
              {loadingOlder ? "Loading older messages…" : "Load older messages"}
            </button>
          </div>
        ) : items.length && startText ? (
          <p className="px-4 pb-2 pt-6 text-xs text-muted">{startText}</p>
        ) : null}
        {!items.length ? (
          <p className="px-4 py-10 text-center text-sm text-muted">{emptyText}</p>
        ) : null}
        {items.map((item) => {
          if (item.kind === "day")
            return (
              <div key={item.key} role="separator" aria-label={item.label} className="flex items-center gap-3 px-4 py-2">
                <span className="h-px flex-1 bg-separator" />
                <span className="rounded-full border border-border bg-surface px-3 py-0.5 text-xs font-medium">
                  {item.label}
                </span>
                <span className="h-px flex-1 bg-separator" />
              </div>
            );
          if (item.kind === "new")
            return (
              <div key="new" data-new-divider role="separator" aria-label="New messages" className="flex items-center gap-2 px-4 py-1">
                <span className="h-px flex-1 bg-danger/60" />
                <span className="text-[11px] font-semibold uppercase tracking-wide text-danger">New</span>
              </div>
            );
          return <div key={item.key}>{renderMessage(item)}</div>;
        })}
      </div>
      {!atBottom ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium shadow-md"
        >
          {unseen ? "New messages · Jump to latest" : "Jump to latest"}
        </button>
      ) : null}
    </div>
  );
}
