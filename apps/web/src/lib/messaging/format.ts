import type { Conversation, Message, UserLite } from "./types";

/** Sunpride works in Manila time; every chat label uses it. */
export const CHAT_TIME_ZONE = "Asia/Manila";

const dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: CHAT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const dayLabelFormat = new Intl.DateTimeFormat("en-PH", {
  timeZone: CHAT_TIME_ZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
});
const dayLabelYearFormat = new Intl.DateTimeFormat("en-PH", {
  timeZone: CHAT_TIME_ZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("en-PH", {
  timeZone: CHAT_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});
const shortDateFormat = new Intl.DateTimeFormat("en-PH", {
  timeZone: CHAT_TIME_ZONE,
  month: "short",
  day: "numeric",
});

/** `2026-11-03` in Manila for an ISO time. */
export function dayKey(iso: string): string {
  return dayKeyFormat.format(new Date(iso));
}

export function dayLabel(iso: string, now: Date = new Date()): string {
  const key = dayKey(iso);
  const today = dayKeyFormat.format(now);
  const yesterday = dayKeyFormat.format(new Date(now.getTime() - 86_400_000));
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  return key.slice(0, 4) === today.slice(0, 4)
    ? dayLabelFormat.format(new Date(iso))
    : dayLabelYearFormat.format(new Date(iso));
}

export function timeLabel(iso: string): string {
  return timeFormat.format(new Date(iso));
}

/** Sidebar time: the clock today, otherwise a short date. */
export function shortTimeLabel(iso: string, now: Date = new Date()): string {
  return dayKey(iso) === dayKeyFormat.format(now)
    ? timeLabel(iso)
    : shortDateFormat.format(new Date(iso));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Messages by the same author within this window share one header. */
export const GROUP_WINDOW_MS = 5 * 60_000;

export type TimelineItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "new"; key: "new" }
  | { kind: "message"; key: string; message: Message; grouped: boolean };

/**
 * Day separators, author grouping and the "New" divider before the first
 * unread message someone else wrote. `messages` must be ascending by seq.
 */
export function buildTimeline(
  messages: readonly Message[],
  options: { lastReadSeq?: number | null; meId?: string | null; now?: Date },
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let previous: Message | undefined;
  let newPlaced = false;
  const lastRead = options.lastReadSeq ?? null;
  for (const message of messages) {
    const day = dayKey(message.created_at);
    let breakGroup = false;
    if (!previous || dayKey(previous.created_at) !== day) {
      items.push({
        kind: "day",
        key: `day-${day}`,
        label: dayLabel(message.created_at, options.now),
      });
      breakGroup = true;
    }
    if (
      !newPlaced &&
      lastRead !== null &&
      message.seq > lastRead &&
      message.author.id !== options.meId
    ) {
      items.push({ kind: "new", key: "new" });
      newPlaced = true;
      breakGroup = true;
    }
    const grouped =
      !breakGroup &&
      previous !== undefined &&
      previous.author.id === message.author.id &&
      !previous.deleted &&
      Date.parse(message.created_at) - Date.parse(previous.created_at) <
        GROUP_WINDOW_MS;
    items.push({ kind: "message", key: message.id, message, grouped });
    previous = message;
  }
  return items;
}

/** Everyone in the preview except the reader. */
export function otherMembers(
  conversation: Pick<Conversation, "members_preview">,
  meId: string | null | undefined,
): UserLite[] {
  const others = conversation.members_preview.filter((m) => m.id !== meId);
  return others.length ? others : conversation.members_preview;
}

/** The server derives DM/group titles; fall back to member names. */
export function conversationTitle(
  conversation: Pick<Conversation, "title" | "kind" | "members_preview" | "member_count">,
  meId: string | null | undefined,
): string {
  if (conversation.title) return conversation.title;
  const names = otherMembers(conversation, meId).map((m) => m.display_name);
  if (!names.length)
    return conversation.kind === "channel" ? "Untitled channel" : "Conversation";
  const extra = conversation.member_count - 1 - names.length;
  return extra > 0 ? `${names.join(", ")} and ${extra} more` : names.join(", ");
}

export type SidebarSectionId = "channels" | "dms" | "groups" | "agents";

export const SIDEBAR_SECTIONS: { id: SidebarSectionId; label: string }[] = [
  { id: "channels", label: "Channels" },
  { id: "dms", label: "Direct messages" },
  { id: "groups", label: "Groups" },
  { id: "agents", label: "AI users" },
];

/** A DM with an agent goes under AI users; other DMs under Direct messages. */
export function sectionOf(
  conversation: Conversation,
  meId: string | null | undefined,
): SidebarSectionId {
  if (conversation.kind === "channel") return "channels";
  if (conversation.kind === "group") return "groups";
  return otherMembers(conversation, meId).some((m) => m.is_agent)
    ? "agents"
    : "dms";
}

export function groupConversations(
  conversations: readonly Conversation[],
  meId: string | null | undefined,
): Record<SidebarSectionId, Conversation[]> {
  const groups: Record<SidebarSectionId, Conversation[]> = {
    channels: [],
    dms: [],
    groups: [],
    agents: [],
  };
  for (const conversation of conversations)
    groups[sectionOf(conversation, meId)].push(conversation);
  return groups;
}

/** Two-letter initials for an avatar placeholder. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)![0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Badge text: counts above 99 collapse. */
export function badgeCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * SP-0148: a link preview image is shown only when it is served by our own API (a same-origin path).
 * A remote `og:image` would be fetched by the browser outside the server's pinned, redirect-checked
 * fetcher, so it is never loaded; the card shows without a picture instead.
 */
export function previewImageSrc(url: string | null | undefined): string | null {
  if (!url || !url.startsWith("/") || url.startsWith("//") || url.includes("\\"))
    return null;
  return url;
}
