import { ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireCapability, CAPABILITIES } from "../lib/capabilities";
import type { AppRole } from "../lib/roles";
import {
  DEFAULT_ISSUE_AREA,
  DEFAULT_VIDEO_UPLOAD_BYTES,
  formatIssueKey,
  ISSUE_AREAS,
  MAX_ATTACHMENTS_PER_COMMENT,
  MAX_SHORT_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  SPARSE_RANK_GAP,
  SUPERADMIN_VIDEO_UPLOAD_BYTES,
  validateAttachment,
  type IssuePriority,
  type IssueStatus,
} from "./constants";
import type {
  issueFieldChangeValidator,
  issueUploadValidator,
} from "./validators";

/**
 * Who is acting. A signed-in person has a profile; an agent calling `issues/agent`
 * through `convex run` has only a label (e.g. "Agent · codex").
 */
export type IssueActor = {
  profileId?: Id<"profiles">;
  label?: string;
  canManage: boolean;
  /** Works issues: status, board moves, assignee and editing the issue (`issues.triage`). */
  canTriage: boolean;
  maxVideoBytes: number;
};

type Upload = Infer<typeof issueUploadValidator>;
type FieldChange = Infer<typeof issueFieldChangeValidator>;

export async function requireIssueActor(
  ctx: QueryCtx | MutationCtx,
  capability:
    "issues.read" | "issues.write" | "issues.triage" | "issues.manage",
): Promise<IssueActor & { profile: Doc<"profiles"> }> {
  const { profile } = await requireCapability(ctx, capability);
  const holds = (name: "issues.triage" | "issues.manage") =>
    profile.role === "super_admin" ||
    (CAPABILITIES[name] as readonly string[]).includes(profile.role);
  return {
    profile,
    profileId: profile._id,
    canManage: holds("issues.manage"),
    canTriage: holds("issues.triage"),
    maxVideoBytes:
      profile.role === "super_admin"
        ? SUPERADMIN_VIDEO_UPLOAD_BYTES
        : DEFAULT_VIDEO_UPLOAD_BYTES,
  };
}

export function agentActor(label: string | undefined): IssueActor {
  const trimmed = label?.trim().slice(0, 80);
  return {
    label: trimmed ? trimmed : "Agent",
    canManage: true,
    canTriage: true,
    maxVideoBytes: DEFAULT_VIDEO_UPLOAD_BYTES,
  };
}

function actorFields(actor: IssueActor) {
  return actor.profileId
    ? { actorId: actor.profileId }
    : { actorLabel: actor.label ?? "Agent" };
}

export function issueKey(issue: Pick<Doc<"issues">, "number">) {
  return formatIssueKey(issue.number);
}

export function cleanTitle(value: string) {
  const title = value.replace(/\s+/g, " ").trim();
  if (!title) throw new ConvexError("Title is required");
  if (title.length > MAX_TITLE_LENGTH)
    throw new ConvexError(
      `Title must be ${MAX_TITLE_LENGTH} characters or fewer`,
    );
  return title;
}

export function cleanText(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) return undefined;
  if (text.length > MAX_TEXT_LENGTH)
    throw new ConvexError(
      `Text must be ${MAX_TEXT_LENGTH} characters or fewer`,
    );
  return text;
}

function cleanShort(value: string | null | undefined, label: string) {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length > MAX_SHORT_LENGTH)
    throw new ConvexError(
      `${label} must be ${MAX_SHORT_LENGTH} characters or fewer`,
    );
  return text;
}

export function cleanExternalRef(value: string | null | undefined) {
  return cleanShort(value, "External reference");
}

export function cleanMilestone(value: string | null | undefined) {
  return cleanShort(value, "Milestone");
}

/** Matches a catalog area case-insensitively; blank means "Others". */
export function normalizeArea(value: string | null | undefined) {
  const text = value?.trim();
  if (!text) return DEFAULT_ISSUE_AREA;
  const match = ISSUE_AREAS.find(
    (area) => area.toLowerCase() === text.toLowerCase(),
  );
  if (!match) throw new ConvexError(`Unknown area: ${text}`);
  return match;
}

export function buildSearchText(input: {
  number: number;
  title: string;
  description?: string;
  steps?: string;
  actual?: string;
  expected?: string;
  externalRef?: string;
  milestone?: string;
}) {
  return [
    formatIssueKey(input.number),
    String(input.number),
    input.title,
    input.description,
    input.steps,
    input.actual,
    input.expected,
    input.externalRef,
    input.milestone,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .toLowerCase();
}

export async function assertAssignee(
  ctx: QueryCtx | MutationCtx,
  profileId: Id<"profiles">,
) {
  const profile = await ctx.db.get(profileId);
  // Issues are assigned to the staff who work them, not to every tester.
  const workers = CAPABILITIES["issues.triage"] as readonly AppRole[];
  if (
    !profile ||
    profile.status !== "active" ||
    (profile.role !== "super_admin" &&
      !workers.includes(profile.role as AppRole))
  )
    throw new ConvexError(
      "Assignee must be an active person with issue access",
    );
  return profile;
}

async function reserveNumber(ctx: MutationCtx) {
  const counter = await ctx.db
    .query("issueCounters")
    .withIndex("by_key", (q) => q.eq("key", "issueNumber"))
    .unique();
  const now = Date.now();
  if (!counter) {
    const last = await ctx.db
      .query("issues")
      .withIndex("by_number")
      .order("desc")
      .first();
    const next = (last?.number ?? 0) + 1;
    await ctx.db.insert("issueCounters", {
      key: "issueNumber",
      lastNumber: next,
      updatedAt: now,
    });
    return next;
  }
  const next = counter.lastNumber + 1;
  await ctx.db.patch(counter._id, { lastNumber: next, updatedAt: now });
  return next;
}

async function nextBottomRank(ctx: MutationCtx, status: IssueStatus) {
  const last = await ctx.db
    .query("issues")
    .withIndex("by_archived_and_status_and_order", (q) =>
      q.eq("archived", false).eq("status", status),
    )
    .order("desc")
    .first();
  return (last?.order ?? 0) + SPARSE_RANK_GAP;
}

async function logActivity(
  ctx: MutationCtx,
  issueId: Id<"issues">,
  actor: IssueActor,
  entry: {
    kind: Doc<"issueActivity">["kind"];
    fromStatus?: IssueStatus;
    toStatus?: IssueStatus;
    changes?: FieldChange[];
    note?: string;
  },
) {
  await ctx.db.insert("issueActivity", {
    issueId,
    ...actorFields(actor),
    ...entry,
    createdAt: Date.now(),
  });
}

export async function loadActiveIssue(ctx: MutationCtx, issueId: Id<"issues">) {
  const issue = await ctx.db.get(issueId);
  if (!issue || issue.archived) throw new ConvexError("Active issue not found");
  return issue;
}

export type CreateIssueInput = {
  title: string;
  description?: string;
  steps?: string;
  actual?: string;
  expected?: string;
  area?: string;
  priority?: IssuePriority;
  assigneeId?: Id<"profiles">;
  externalRef?: string;
  milestone?: string;
  status?: IssueStatus;
  uploads?: Upload[];
};

export async function createIssue(
  ctx: MutationCtx,
  input: CreateIssueInput,
  actor: IssueActor,
) {
  const title = cleanTitle(input.title);
  const area = normalizeArea(input.area);
  if (input.assigneeId) await assertAssignee(ctx, input.assigneeId);
  const status = input.status ?? "draft";
  const number = await reserveNumber(ctx);
  const now = Date.now();
  const fields = {
    number,
    title,
    description: cleanText(input.description),
    steps: cleanText(input.steps),
    actual: cleanText(input.actual),
    expected: cleanText(input.expected),
    externalRef: cleanExternalRef(input.externalRef),
    milestone: cleanMilestone(input.milestone),
  };
  const issueId = await ctx.db.insert("issues", {
    ...fields,
    area,
    priority: input.priority ?? "medium",
    status,
    order: await nextBottomRank(ctx, status),
    assigneeId: input.assigneeId,
    ...(actor.profileId
      ? { reporterId: actor.profileId }
      : { reporterLabel: actor.label ?? "Agent" }),
    archived: false,
    searchText: buildSearchText(fields),
    commentCount: 0,
    attachmentCount: 0,
    createdAt: now,
    updatedAt: now,
    updatedBy: actor.profileId,
  });
  await logActivity(ctx, issueId, actor, {
    kind: "created",
    note: formatIssueKey(number),
  });
  if (input.uploads?.length) {
    await addComment(
      ctx,
      {
        issueId,
        body: "Attachments added when the issue was created.",
        uploads: input.uploads,
      },
      actor,
    );
  }
  return { issueId, number, key: formatIssueKey(number) };
}

export type UpdateIssueInput = {
  title?: string;
  description?: string | null;
  steps?: string | null;
  actual?: string | null;
  expected?: string | null;
  area?: string;
  priority?: IssuePriority;
  assigneeId?: Id<"profiles"> | null;
  externalRef?: string | null;
  milestone?: string | null;
};

const EDITABLE_FIELDS = [
  "title",
  "description",
  "steps",
  "actual",
  "expected",
  "area",
  "priority",
  "assigneeId",
  "externalRef",
  "milestone",
] as const;

export async function updateIssue(
  ctx: MutationCtx,
  issueId: Id<"issues">,
  input: UpdateIssueInput,
  actor: IssueActor,
) {
  const issue = await loadActiveIssue(ctx, issueId);
  if (input.assigneeId) await assertAssignee(ctx, input.assigneeId);
  // undefined keeps the stored value; null (or blank) clears an optional field.
  const pick = (
    value: string | null | undefined,
    clean: (text: string | null | undefined) => string | undefined,
    current: string | undefined,
  ) => (value === undefined ? current : clean(value));
  const next = {
    title: input.title === undefined ? issue.title : cleanTitle(input.title),
    description: pick(input.description, cleanText, issue.description),
    steps: pick(input.steps, cleanText, issue.steps),
    actual: pick(input.actual, cleanText, issue.actual),
    expected: pick(input.expected, cleanText, issue.expected),
    area: input.area === undefined ? issue.area : normalizeArea(input.area),
    priority: input.priority ?? issue.priority,
    assigneeId:
      input.assigneeId === undefined
        ? issue.assigneeId
        : (input.assigneeId ?? undefined),
    externalRef: pick(input.externalRef, cleanExternalRef, issue.externalRef),
    milestone: pick(input.milestone, cleanMilestone, issue.milestone),
  };
  const changes: FieldChange[] = [];
  for (const field of EDITABLE_FIELDS) {
    if (issue[field] === next[field]) continue;
    if (field === "assigneeId") {
      // Store names, never profile IDs: the activity log is read by people.
      const nameOf = async (id: Id<"profiles"> | undefined) =>
        id ? ((await ctx.db.get(id))?.name ?? "Former user") : null;
      changes.push({
        field: "assignee",
        from: await nameOf(issue.assigneeId),
        to: await nameOf(next.assigneeId),
      });
      continue;
    }
    changes.push({
      field,
      from: issue[field] === undefined ? null : String(issue[field]),
      to: next[field] === undefined ? null : String(next[field]),
    });
  }
  if (changes.length === 0) return { changed: false };
  await ctx.db.patch(issueId, {
    ...next,
    searchText: buildSearchText({ ...next, number: issue.number }),
    updatedAt: Date.now(),
    updatedBy: actor.profileId,
  });
  await logActivity(ctx, issueId, actor, { kind: "updated", changes });
  return { changed: true };
}

async function calculateRank(
  ctx: MutationCtx,
  args: {
    issueId: Id<"issues">;
    status: IssueStatus;
    beforeId?: Id<"issues">;
    afterId?: Id<"issues">;
  },
) {
  if (!args.beforeId && !args.afterId) return nextBottomRank(ctx, args.status);
  const cards = (
    await ctx.db
      .query("issues")
      .withIndex("by_archived_and_status_and_order", (q) =>
        q.eq("archived", false).eq("status", args.status),
      )
      .take(2000)
  ).filter((card) => card._id !== args.issueId);
  if (cards.length >= 2000)
    throw new ConvexError("This column is too large to reorder");
  const before = args.beforeId
    ? cards.find((card) => card._id === args.beforeId)
    : undefined;
  const after = args.afterId
    ? cards.find((card) => card._id === args.afterId)
    : undefined;
  if (args.beforeId && !before)
    throw new ConvexError("Previous card is no longer in this column");
  if (args.afterId && !after)
    throw new ConvexError("Next card is no longer in this column");
  if (before && after && before.order >= after.order)
    throw new ConvexError("Cards are out of order");
  const lower = before?.order;
  const upper = after?.order;
  if (lower === undefined) return (upper ?? SPARSE_RANK_GAP) - SPARSE_RANK_GAP;
  if (upper === undefined) return lower + SPARSE_RANK_GAP;
  if (upper - lower > 1) return lower + Math.floor((upper - lower) / 2);
  // No room between the anchors: respace the column, then place between them.
  for (const [index, card] of cards.entries())
    await ctx.db.patch(card._id, { order: (index + 1) * SPARSE_RANK_GAP });
  const lowerIndex = cards.findIndex((card) => card._id === args.beforeId);
  return (lowerIndex + 1) * SPARSE_RANK_GAP + SPARSE_RANK_GAP / 2;
}

export async function moveIssue(
  ctx: MutationCtx,
  args: {
    issueId: Id<"issues">;
    status: IssueStatus;
    beforeId?: Id<"issues">;
    afterId?: Id<"issues">;
  },
  actor: IssueActor,
) {
  const issue = await loadActiveIssue(ctx, args.issueId);
  if (args.beforeId === args.issueId || args.afterId === args.issueId)
    throw new ConvexError("An issue cannot anchor itself");
  const statusChanged = issue.status !== args.status;
  if (!statusChanged && !args.beforeId && !args.afterId)
    return { changed: false };
  const order = await calculateRank(ctx, args);
  await ctx.db.patch(args.issueId, {
    status: args.status,
    order,
    ...(statusChanged
      ? { updatedAt: Date.now(), updatedBy: actor.profileId }
      : {}),
  });
  if (statusChanged)
    await logActivity(ctx, args.issueId, actor, {
      kind: "status_changed",
      fromStatus: issue.status,
      toStatus: args.status,
    });
  return { changed: statusChanged };
}

export async function archiveIssue(
  ctx: MutationCtx,
  issueId: Id<"issues">,
  actor: IssueActor,
) {
  await loadActiveIssue(ctx, issueId);
  const now = Date.now();
  await ctx.db.patch(issueId, {
    archived: true,
    archivedAt: now,
    updatedAt: now,
    updatedBy: actor.profileId,
  });
  await logActivity(ctx, issueId, actor, { kind: "archived" });
}

export async function restoreIssue(
  ctx: MutationCtx,
  issueId: Id<"issues">,
  actor: IssueActor,
) {
  const issue = await ctx.db.get(issueId);
  if (!issue || !issue.archived)
    throw new ConvexError("Archived issue not found");
  const now = Date.now();
  await ctx.db.patch(issueId, {
    archived: false,
    archivedAt: undefined,
    order: await nextBottomRank(ctx, issue.status),
    updatedAt: now,
    updatedBy: actor.profileId,
  });
  await logActivity(ctx, issueId, actor, { kind: "restored" });
}

async function validateUploads(
  ctx: MutationCtx,
  uploads: Upload[],
  actor: IssueActor,
) {
  const unique = [
    ...new Map(uploads.map((upload) => [upload.storageId, upload])).values(),
  ];
  if (unique.length > MAX_ATTACHMENTS_PER_COMMENT)
    throw new ConvexError(
      `A comment can carry at most ${MAX_ATTACHMENTS_PER_COMMENT} attachments`,
    );
  const checked = [];
  for (const upload of unique) {
    const fileName = upload.fileName.trim().slice(0, 200);
    if (!fileName) throw new ConvexError("Every attachment needs a file name");
    const used = await ctx.db
      .query("issueAttachments")
      .withIndex("by_storageId", (q) => q.eq("storageId", upload.storageId))
      .first();
    if (used) throw new ConvexError("That file is already attached");
    const metadata = await ctx.db.system.get(upload.storageId);
    if (!metadata) throw new ConvexError("Upload not found. Try again.");
    const fileType = (metadata.contentType ?? "").toLowerCase();
    const problem = validateAttachment({
      fileType,
      fileSize: metadata.size,
      maxVideoBytes: actor.maxVideoBytes,
    });
    if (problem) throw new ConvexError(`${fileName}: ${problem}`);
    checked.push({
      storageId: upload.storageId,
      fileName,
      fileType,
      fileSize: metadata.size,
    });
  }
  return checked;
}

export async function addComment(
  ctx: MutationCtx,
  args: { issueId: Id<"issues">; body: string; uploads?: Upload[] },
  actor: IssueActor,
) {
  const issue = await loadActiveIssue(ctx, args.issueId);
  const body = cleanText(args.body) ?? "";
  const files = await validateUploads(ctx, args.uploads ?? [], actor);
  if (!body && files.length === 0)
    throw new ConvexError("Write a comment or attach a file");
  const now = Date.now();
  const commentId = await ctx.db.insert("issueComments", {
    issueId: args.issueId,
    ...(actor.profileId
      ? { authorId: actor.profileId }
      : { authorLabel: actor.label ?? "Agent" }),
    body,
    createdAt: now,
  });
  for (const file of files)
    await ctx.db.insert("issueAttachments", {
      issueId: args.issueId,
      commentId,
      ...file,
      uploadedBy: actor.profileId,
      createdAt: now,
    });
  await ctx.db.patch(args.issueId, {
    commentCount: issue.commentCount + 1,
    attachmentCount: issue.attachmentCount + files.length,
    lastCommentAt: now,
    lastCommentAuthorId: actor.profileId,
    lastCommentAuthorLabel: actor.profileId
      ? undefined
      : (actor.label ?? "Agent"),
    updatedAt: now,
    updatedBy: actor.profileId,
  });
  await logActivity(ctx, args.issueId, actor, {
    kind: "commented",
    ...(files.length ? { note: `${files.length} attachment(s)` } : {}),
  });
  return commentId;
}

async function loadOwnComment(
  ctx: MutationCtx,
  commentId: Id<"issueComments">,
  actor: IssueActor,
  allowManager: boolean,
) {
  const comment = await ctx.db.get(commentId);
  if (!comment || comment.deletedAt) throw new ConvexError("Comment not found");
  const isAuthor =
    actor.profileId !== undefined && comment.authorId === actor.profileId;
  if (!isAuthor && !(allowManager && actor.canManage))
    throw new ConvexError("Only the author can change this comment");
  const issue = await loadActiveIssue(ctx, comment.issueId);
  return { comment, issue };
}

export async function updateComment(
  ctx: MutationCtx,
  args: { commentId: Id<"issueComments">; body: string },
  actor: IssueActor,
) {
  const { comment } = await loadOwnComment(ctx, args.commentId, actor, false);
  const body = cleanText(args.body) ?? "";
  if (body === comment.body) return;
  if (!body) {
    const files = await ctx.db
      .query("issueAttachments")
      .withIndex("by_commentId", (q) => q.eq("commentId", comment._id))
      .first();
    if (!files) throw new ConvexError("Write a comment or attach a file");
  }
  await ctx.db.patch(comment._id, { body, updatedAt: Date.now() });
  await logActivity(ctx, comment.issueId, actor, { kind: "comment_updated" });
}

export async function deleteComment(
  ctx: MutationCtx,
  commentId: Id<"issueComments">,
  actor: IssueActor,
) {
  const { comment, issue } = await loadOwnComment(ctx, commentId, actor, true);
  const files = await ctx.db
    .query("issueAttachments")
    .withIndex("by_commentId", (q) => q.eq("commentId", commentId))
    .take(MAX_ATTACHMENTS_PER_COMMENT + 1);
  for (const file of files) {
    await ctx.storage.delete(file.storageId);
    await ctx.db.delete(file._id);
  }
  const now = Date.now();
  await ctx.db.patch(commentId, { deletedAt: now, updatedAt: now });
  await ctx.db.patch(issue._id, {
    commentCount: Math.max(0, issue.commentCount - 1),
    attachmentCount: Math.max(0, issue.attachmentCount - files.length),
    updatedAt: now,
    updatedBy: actor.profileId,
  });
  await logActivity(ctx, comment.issueId, actor, { kind: "comment_deleted" });
}

export async function removeAttachment(
  ctx: MutationCtx,
  attachmentId: Id<"issueAttachments">,
  actor: IssueActor,
) {
  const file = await ctx.db.get(attachmentId);
  if (!file) throw new ConvexError("Attachment not found");
  const { issue } = await loadOwnComment(ctx, file.commentId, actor, true);
  await ctx.storage.delete(file.storageId);
  await ctx.db.delete(file._id);
  const now = Date.now();
  await ctx.db.patch(issue._id, {
    attachmentCount: Math.max(0, issue.attachmentCount - 1),
    updatedAt: now,
    updatedBy: actor.profileId,
  });
  await logActivity(ctx, issue._id, actor, {
    kind: "attachment_removed",
    note: file.fileName,
  });
}
