import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireActiveProfile } from "../lib/auth";
import { CAPABILITIES } from "../lib/capabilities";
import type { AppRole } from "../lib/roles";
import schema from "../schema";
import {
  attachmentKind,
  DEFAULT_VIDEO_UPLOAD_BYTES,
  formatIssueKey,
  ISSUE_BOARD_LIMIT,
  ISSUE_STATUSES,
  parseIssueKey,
  SUPERADMIN_VIDEO_UPLOAD_BYTES,
} from "./constants";
import { requireIssueActor } from "./service";
import {
  issueActivityKindValidator,
  issueFieldChangeValidator,
  issuePriorityValidator,
  issueStatusValidator,
} from "./validators";

const FORMER_USER = "Former user";

/** Resolves profile names once per query. */
export function nameResolver(ctx: QueryCtx) {
  const cache = new Map<Id<"profiles">, Promise<string>>();
  return (profileId: Id<"profiles"> | undefined, label?: string) => {
    if (!profileId) return Promise.resolve(label ?? "Agent");
    let name = cache.get(profileId);
    if (!name) {
      name = ctx.db.get(profileId).then((p) => p?.name ?? FORMER_USER);
      cache.set(profileId, name);
    }
    return name;
  };
}

export const issueCardValidator = v.object({
  _id: v.id("issues"),
  number: v.number(),
  key: v.string(),
  title: v.string(),
  area: v.string(),
  priority: issuePriorityValidator,
  status: issueStatusValidator,
  order: v.number(),
  milestone: v.optional(v.string()),
  externalRef: v.optional(v.string()),
  assigneeId: v.optional(v.id("profiles")),
  assigneeName: v.optional(v.string()),
  reporterId: v.optional(v.id("profiles")),
  reporterName: v.string(),
  commentCount: v.number(),
  attachmentCount: v.number(),
  lastCommentAt: v.optional(v.number()),
  lastCommentAuthorName: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export async function toCard(
  issue: Doc<"issues">,
  name: ReturnType<typeof nameResolver>,
) {
  return {
    _id: issue._id,
    number: issue.number,
    key: formatIssueKey(issue.number),
    title: issue.title,
    area: issue.area,
    priority: issue.priority,
    status: issue.status,
    order: issue.order,
    milestone: issue.milestone,
    externalRef: issue.externalRef,
    assigneeId: issue.assigneeId,
    assigneeName: issue.assigneeId ? await name(issue.assigneeId) : undefined,
    reporterId: issue.reporterId,
    reporterName: await name(issue.reporterId, issue.reporterLabel),
    commentCount: issue.commentCount,
    attachmentCount: issue.attachmentCount,
    lastCommentAt: issue.lastCommentAt,
    lastCommentAuthorName: issue.lastCommentAt
      ? await name(issue.lastCommentAuthorId, issue.lastCommentAuthorLabel)
      : undefined,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

const countsValidator = v.object({
  draft: v.number(),
  ongoing_test: v.number(),
  need_to_rectify: v.number(),
  awaiting_client_response: v.number(),
  dev_work_ongoing: v.number(),
  for_retest: v.number(),
  completed: v.number(),
});

export const boardFiltersValidator = {
  archived: v.boolean(),
  search: v.optional(v.string()),
  status: v.optional(issueStatusValidator),
  area: v.optional(v.string()),
  priority: v.optional(issuePriorityValidator),
  assigneeId: v.optional(v.union(v.id("profiles"), v.literal("unassigned"))),
  reporterId: v.optional(v.id("profiles")),
  milestone: v.optional(v.string()),
};

type BoardFilters = {
  archived: boolean;
  search?: string;
  status?: Doc<"issues">["status"];
  area?: string;
  priority?: Doc<"issues">["priority"];
  assigneeId?: Id<"profiles"> | "unassigned";
  reporterId?: Id<"profiles">;
  milestone?: string;
};

/**
 * Reads at most ISSUE_BOARD_LIMIT issues (newest activity first, or best search match)
 * and applies the remaining filters in memory. `truncated` tells the caller the cap hit.
 */
export async function readBoard(ctx: QueryCtx, filters: BoardFilters) {
  const search = filters.search?.trim().toLowerCase();
  const rows = search
    ? await ctx.db
        .query("issues")
        .withSearchIndex("search_issues", (q) =>
          q.search("searchText", search).eq("archived", filters.archived),
        )
        .take(ISSUE_BOARD_LIMIT + 1)
    : await ctx.db
        .query("issues")
        .withIndex("by_archived_and_updatedAt", (q) =>
          q.eq("archived", filters.archived),
        )
        .order("desc")
        .take(ISSUE_BOARD_LIMIT + 1);
  const truncated = rows.length > ISSUE_BOARD_LIMIT;
  const matching = rows
    .slice(0, ISSUE_BOARD_LIMIT)
    .filter(
      (issue) =>
        (!filters.area || issue.area === filters.area) &&
        (!filters.priority || issue.priority === filters.priority) &&
        (!filters.milestone || issue.milestone === filters.milestone) &&
        (!filters.reporterId || issue.reporterId === filters.reporterId) &&
        (!filters.assigneeId ||
          (filters.assigneeId === "unassigned"
            ? !issue.assigneeId
            : issue.assigneeId === filters.assigneeId)),
    );
  const counts = Object.fromEntries(
    ISSUE_STATUSES.map((status) => [
      status,
      matching.filter((issue) => issue.status === status).length,
    ]),
  ) as Record<Doc<"issues">["status"], number>;
  const milestones = [
    ...new Set(
      rows.flatMap((issue) => (issue.milestone ? [issue.milestone] : [])),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const issues = filters.status
    ? matching.filter((issue) => issue.status === filters.status)
    : matching;
  return { issues, counts, truncated, milestones };
}

export const access = query({
  args: {},
  returns: v.object({
    canRead: v.boolean(),
    canWrite: v.boolean(),
    canManage: v.boolean(),
    maxVideoBytes: v.number(),
  }),
  handler: async (ctx) => {
    const { profile } = await requireActiveProfile(ctx);
    const holds = (capability: keyof typeof CAPABILITIES) =>
      profile.role === "super_admin" ||
      (CAPABILITIES[capability] as readonly string[]).includes(profile.role);
    return {
      canRead: holds("issues.read"),
      canWrite: holds("issues.write"),
      canManage: holds("issues.manage"),
      maxVideoBytes:
        profile.role === "super_admin"
          ? SUPERADMIN_VIDEO_UPLOAD_BYTES
          : DEFAULT_VIDEO_UPLOAD_BYTES,
    };
  },
});

export const board = query({
  args: boardFiltersValidator,
  returns: v.object({
    issues: v.array(issueCardValidator),
    counts: countsValidator,
    truncated: v.boolean(),
    milestones: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    await requireIssueActor(ctx, "issues.read");
    const result = await readBoard(ctx, args);
    const name = nameResolver(ctx);
    const issues = await Promise.all(
      result.issues.map((issue) => toCard(issue, name)),
    );
    // Newest activity first (or best search match); the board sorts each column by `order`.
    return { ...result, issues };
  },
});

export const assignees = query({
  args: {},
  returns: v.array(
    v.object({ _id: v.id("profiles"), name: v.string(), role: v.string() }),
  ),
  handler: async (ctx) => {
    await requireIssueActor(ctx, "issues.read");
    const roles = CAPABILITIES["issues.read"] as readonly AppRole[];
    const people = [];
    for (const role of roles) {
      const rows = await ctx.db
        .query("profiles")
        .withIndex("by_role", (q) => q.eq("role", role))
        .take(200);
      for (const row of rows)
        if (row.status === "active")
          people.push({ _id: row._id, name: row.name, role: row.role });
    }
    return people.sort((a, b) => a.name.localeCompare(b.name));
  },
});

const attachmentValue = v.object({
  _id: v.id("issueAttachments"),
  fileName: v.string(),
  fileType: v.string(),
  fileSize: v.number(),
  kind: v.union(v.literal("image"), v.literal("video"), v.literal("document")),
  url: v.union(v.string(), v.null()),
});

export const commentValue = v.object({
  _id: v.id("issueComments"),
  authorId: v.optional(v.id("profiles")),
  authorName: v.string(),
  body: v.string(),
  createdAt: v.number(),
  updatedAt: v.optional(v.number()),
  canEdit: v.boolean(),
  canDelete: v.boolean(),
  attachments: v.array(attachmentValue),
});

export const activityValue = v.object({
  _id: v.id("issueActivity"),
  kind: issueActivityKindValidator,
  actorName: v.string(),
  fromStatus: v.optional(issueStatusValidator),
  toStatus: v.optional(issueStatusValidator),
  changes: v.optional(v.array(issueFieldChangeValidator)),
  note: v.optional(v.string()),
  createdAt: v.number(),
});

export async function readDetail(
  ctx: QueryCtx,
  issue: Doc<"issues">,
  viewer: { profileId?: Id<"profiles">; canManage: boolean },
) {
  const name = nameResolver(ctx);
  const comments = await ctx.db
    .query("issueComments")
    .withIndex("by_issueId_and_createdAt", (q) => q.eq("issueId", issue._id))
    .take(300);
  const activity = await ctx.db
    .query("issueActivity")
    .withIndex("by_issueId_and_createdAt", (q) => q.eq("issueId", issue._id))
    .order("desc")
    .take(200);
  return {
    issue,
    key: formatIssueKey(issue.number),
    reporterName: await name(issue.reporterId, issue.reporterLabel),
    assigneeName: issue.assigneeId ? await name(issue.assigneeId) : undefined,
    comments: await Promise.all(
      comments
        .filter((comment) => !comment.deletedAt)
        .map(async (comment) => {
          const isAuthor =
            viewer.profileId !== undefined &&
            comment.authorId === viewer.profileId;
          const files = await ctx.db
            .query("issueAttachments")
            .withIndex("by_commentId", (q) => q.eq("commentId", comment._id))
            .take(10);
          return {
            _id: comment._id,
            authorId: comment.authorId,
            authorName: await name(comment.authorId, comment.authorLabel),
            body: comment.body,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
            canEdit: isAuthor && !issue.archived,
            canDelete: (isAuthor || viewer.canManage) && !issue.archived,
            attachments: await Promise.all(
              files.map(async (file) => ({
                _id: file._id,
                fileName: file.fileName,
                fileType: file.fileType,
                fileSize: file.fileSize,
                kind: attachmentKind(file.fileType) ?? "document",
                url: await ctx.storage.getUrl(file.storageId),
              })),
            ),
          };
        }),
    ),
    activity: await Promise.all(
      activity.map(async (entry) => ({
        _id: entry._id,
        kind: entry.kind,
        actorName: await name(entry.actorId, entry.actorLabel),
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        changes: entry.changes,
        note: entry.note,
        createdAt: entry.createdAt,
      })),
    ),
  };
}

export const detail = query({
  args: { number: v.union(v.number(), v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      issue: schema.doc("issues"),
      key: v.string(),
      reporterName: v.string(),
      assigneeName: v.optional(v.string()),
      comments: v.array(commentValue),
      activity: v.array(activityValue),
    }),
  ),
  handler: async (ctx, args) => {
    const actor = await requireIssueActor(ctx, "issues.read");
    const number = parseIssueKey(args.number);
    if (number === undefined) return null;
    const issue = await ctx.db
      .query("issues")
      .withIndex("by_number", (q) => q.eq("number", number))
      .unique();
    if (!issue) return null;
    return readDetail(ctx, issue, actor);
  },
});
