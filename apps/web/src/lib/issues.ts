// Client-safe mirror of backend issue constants. The parity test prevents drift.
import { ConvexError } from "convex/values";

/** The server's own message for a rejected mutation (e.g. "Unknown area"), else the fallback. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ConvexError && typeof error.data === "string")
    return error.data;
  return fallback;
}

/** Long text fields are summarised ("edited description"), never quoted in the log. */
const LONG_TEXT_FIELDS = new Set([
  "description",
  "steps",
  "actual",
  "expected",
]);
export const ISSUE_STATUSES = [
  "draft",
  "ongoing_test",
  "need_to_rectify",
  "awaiting_client_response",
  "dev_work_ongoing",
  "for_retest",
  "completed",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  draft: "Backlog",
  ongoing_test: "In QA",
  need_to_rectify: "Needs fix",
  awaiting_client_response: "Awaiting client response",
  dev_work_ongoing: "In progress",
  for_retest: "Ready for retest",
  completed: "Done",
};
export const ISSUE_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];
export const ISSUE_AREAS = [
  "Sign-in",
  "Home",
  "Orders",
  "Master data",
  "Imports",
  "Inventory",
  "Coverage",
  "Outlets and routes",
  "Visits",
  "Field iOS",
  "Field Android",
  "Integration",
  "Approvals",
  "Reports",
  "Admin",
  "Issues",
  "Others",
] as const;
export const DEFAULT_ISSUE_AREA = "Others";
export const ISSUE_KEY_PREFIX = "SP-";
export const SPARSE_RANK_GAP = 1024;
export const MAX_ATTACHMENTS_PER_COMMENT = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const DEFAULT_VIDEO_UPLOAD_BYTES = 75 * 1024 * 1024;
export const SUPERADMIN_VIDEO_UPLOAD_BYTES = 150 * 1024 * 1024;
export const ISSUE_BOARD_LIMIT = 500;
export const MAX_TITLE_LENGTH = 200;
/** External reference and milestone. */
export const MAX_SHORT_LENGTH = 120;
export const MAX_TEXT_LENGTH = 20_000;
export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/x-m4v",
  "video/webm",
  "video/quicktime",
] as const;
export const ALLOWED_DOCUMENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;
export type IssueAttachmentKind = "image" | "video" | "document";
export function attachmentKind(
  fileType: string,
): IssueAttachmentKind | undefined {
  const type = fileType.toLowerCase();
  if ((ALLOWED_IMAGE_TYPES as readonly string[]).includes(type)) return "image";
  if ((ALLOWED_VIDEO_TYPES as readonly string[]).includes(type)) return "video";
  if ((ALLOWED_DOCUMENT_TYPES as readonly string[]).includes(type))
    return "document";
}
export function validateAttachment(input: {
  fileType: string;
  fileSize: number;
  maxVideoBytes: number;
}): string | undefined {
  const kind = attachmentKind(input.fileType);
  if (!kind) return "Use an image, video, PDF or Word file";
  const limit =
    kind === "image"
      ? MAX_IMAGE_BYTES
      : kind === "video"
        ? input.maxVideoBytes
        : MAX_DOCUMENT_BYTES;
  if (input.fileSize > limit) {
    const noun =
      kind === "image" ? "Image" : kind === "video" ? "Video" : "Document";
    return `${noun} must be ${limit / (1024 * 1024)} MB or smaller`;
  }
}
export function formatIssueKey(issueNumber: number): string {
  return `${ISSUE_KEY_PREFIX}${String(issueNumber).padStart(4, "0")}`;
}
export function parseIssueKey(value: string | number): number | undefined {
  if (typeof value === "number")
    return Number.isInteger(value) && value > 0 ? value : undefined;
  const match = /^(?:sp-?)?0*(\d{1,9})$/i.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return parsed > 0 ? parsed : undefined;
}
export const ISSUE_STATUS_DOTS: Record<IssueStatus, string> = {
  draft: "bg-muted",
  ongoing_test: "bg-accent",
  need_to_rectify: "bg-danger",
  awaiting_client_response: "bg-accent/50",
  dev_work_ongoing: "bg-warning",
  for_retest: "bg-success/50",
  completed: "bg-success",
};
export const ISSUE_STATUS_TONES = {
  draft: "neutral",
  ongoing_test: "warning",
  need_to_rectify: "danger",
  awaiting_client_response: "neutral",
  dev_work_ongoing: "warning",
  for_retest: "success",
  completed: "success",
} as const;
export const ATTACHMENT_ACCEPT = [
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_VIDEO_TYPES,
  ...ALLOWED_DOCUMENT_TYPES,
].join(",");
export function relativeTimestamp(value: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - value) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
export function absoluteTimestamp(value: number): string {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function activityText(event: {
  kind: string;
  fromStatus?: IssueStatus;
  toStatus?: IssueStatus;
  changes?: { field: string; from: string | null; to: string | null }[];
}): string {
  if (event.kind === "status_changed")
    return `moved the issue from ${event.fromStatus ? ISSUE_STATUS_LABELS[event.fromStatus] : "Backlog"} to ${event.toStatus ? ISSUE_STATUS_LABELS[event.toStatus] : "Backlog"}`;
  if (event.kind === "updated" && event.changes?.length) {
    const fields: Record<string, string> = {
      assigneeId: "assignee",
      title: "title",
      externalRef: "reference",
      steps: "steps to reproduce",
      actual: "actual behavior",
      expected: "expected behavior",
    };
    return event.changes
      .map((change) => {
        const name = fields[change.field] ?? change.field;
        if (LONG_TEXT_FIELDS.has(change.field)) return `edited ${name}`;
        return `changed ${name} from ${change.from ?? "empty"} to ${change.to ?? "empty"}`;
      })
      .join(" · ");
  }
  const labels: Record<string, string> = {
    created: "created the issue",
    updated: "updated the issue",
    commented: "added a comment",
    comment_updated: "edited a comment",
    comment_deleted: "removed a comment",
    attachment_removed: "removed an attachment",
    archived: "archived the issue",
    restored: "restored the issue",
  };
  return labels[event.kind] ?? event.kind.replaceAll("_", " ");
}
/** before = card above; after = card below, per the backend move contract. */
export function dropNeighbors<T extends { _id: string }>(
  cards: T[],
  draggedId: string,
  targetId?: string,
  below = false,
) {
  const remaining = cards.filter((card) => card._id !== draggedId);
  const target = targetId
    ? remaining.findIndex((card) => card._id === targetId)
    : -1;
  const index = target < 0 ? remaining.length : target + (below ? 1 : 0);
  return {
    beforeId: remaining[index - 1]?._id,
    afterId: remaining[index]?._id,
  };
}
