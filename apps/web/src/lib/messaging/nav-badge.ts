import type { UnreadSummary } from "./types";

/**
 * Nav badge text for Messages: the unread total, marked with `@` when some
 * of it mentions you. Nothing when everything is read.
 */
export function unreadBadgeText(
  summary: UnreadSummary | null | undefined,
): string | undefined {
  if (!summary || summary.total <= 0) return undefined;
  const total = summary.total > 99 ? "99+" : String(summary.total);
  return summary.mentions > 0 ? `@ ${total}` : total;
}
