// Pure issue constants; literals and labels preserved from the legacy tracker.
export const ISSUE_STATUSES = /** @type {const} */ ([
  "draft",
  "ongoing_test",
  "need_to_rectify",
  "awaiting_client_response",
  "dev_work_ongoing",
  "for_retest",
  "completed",
]);
export const ISSUE_STATUS_LABELS = {
  draft: "Backlog",
  ongoing_test: "In QA",
  need_to_rectify: "Needs fix",
  awaiting_client_response: "Awaiting client response",
  dev_work_ongoing: "In progress",
  for_retest: "Ready for retest",
  completed: "Done",
};
export const ISSUE_PRIORITIES = /** @type {const} */ ([
  "low",
  "medium",
  "high",
  "critical",
]);
export const ISSUE_AREAS = /** @type {const} */ ([
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
]);
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
export const MAX_SHORT_LENGTH = 120;
export const MAX_TEXT_LENGTH = 20_000;
export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
export const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/x-m4v",
  "video/webm",
  "video/quicktime",
];
export const ALLOWED_DOCUMENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
/** @param {string} fileType @returns {'image'|'video'|'document'|undefined} */
export function attachmentKind(fileType) {
  const type = fileType.toLowerCase();
  if (ALLOWED_IMAGE_TYPES.includes(type)) return "image";
  if (ALLOWED_VIDEO_TYPES.includes(type)) return "video";
  if (ALLOWED_DOCUMENT_TYPES.includes(type)) return "document";
}
/** @param {{fileType:string,fileSize:number,maxVideoBytes:number}} input */
export function validateAttachment(input) {
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
/** @param {number} issueNumber */
export function formatIssueKey(issueNumber) {
  return `${ISSUE_KEY_PREFIX}${String(issueNumber).padStart(4, "0")}`;
}
/** @param {string|number} value */
export function parseIssueKey(value) {
  if (typeof value === "number")
    return Number.isInteger(value) && value > 0 ? value : undefined;
  const match = /^(?:sp-?)?0*(\d{1,9})$/i.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return parsed > 0 ? parsed : undefined;
}
