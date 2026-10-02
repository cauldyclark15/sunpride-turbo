import { v } from "convex/values";

export const issueStatusValidator = v.union(
  v.literal("draft"),
  v.literal("ongoing_test"),
  v.literal("need_to_rectify"),
  v.literal("awaiting_client_response"),
  v.literal("dev_work_ongoing"),
  v.literal("for_retest"),
  v.literal("completed"),
);

export const issuePriorityValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("critical"),
);

export const issueActivityKindValidator = v.union(
  v.literal("created"),
  v.literal("updated"),
  v.literal("status_changed"),
  v.literal("commented"),
  v.literal("comment_updated"),
  v.literal("comment_deleted"),
  v.literal("attachment_removed"),
  v.literal("archived"),
  v.literal("restored"),
);

export const issueFieldChangeValidator = v.object({
  field: v.string(),
  from: v.union(v.string(), v.null()),
  to: v.union(v.string(), v.null()),
});

/** A file already uploaded to Convex storage, named by the uploader. */
export const issueUploadValidator = v.object({
  storageId: v.id("_storage"),
  fileName: v.string(),
});
