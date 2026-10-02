// Pure constants for the issue tracker. No imports: the web keeps a mirror of these
// lists (apps/web/src/lib/issues.ts) and a Vitest test compares the two.

/** Workflow copied from the CMS internal-issues board; labels are sentence case. */
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

/** Product areas of Sunpride. "Others" is the default when none is chosen. */
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
/** Board/list queries read at most this many issues per call. */
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
  return undefined;
}

/** Returns an error message, or undefined when the file is acceptable. */
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
  return undefined;
}

export function formatIssueKey(issueNumber: number): string {
  return `${ISSUE_KEY_PREFIX}${String(issueNumber).padStart(4, "0")}`;
}

/** Accepts 12, "12", "SP-12", "sp-0012"; returns undefined for anything else. */
export function parseIssueKey(value: string | number): number | undefined {
  if (typeof value === "number")
    return Number.isInteger(value) && value > 0 ? value : undefined;
  const match = /^(?:sp-?)?0*(\d{1,9})$/i.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return parsed > 0 ? parsed : undefined;
}
