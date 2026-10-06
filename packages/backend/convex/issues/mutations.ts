import { ConvexError, v } from "convex/values";
import { mutation } from "../_generated/server";
import * as service from "./service";
import {
  issuePriorityValidator,
  issueStatusValidator,
  issueUploadValidator,
} from "./validators";

const nullableText = v.optional(v.union(v.string(), v.null()));

export const create = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    steps: v.optional(v.string()),
    actual: v.optional(v.string()),
    expected: v.optional(v.string()),
    area: v.optional(v.string()),
    priority: v.optional(issuePriorityValidator),
    assigneeId: v.optional(v.id("profiles")),
    externalRef: v.optional(v.string()),
    milestone: v.optional(v.string()),
    uploads: v.optional(v.array(issueUploadValidator)),
  },
  returns: v.object({
    issueId: v.id("issues"),
    number: v.number(),
    key: v.string(),
  }),
  handler: async (ctx, args) => {
    const actor = await service.requireIssueActor(ctx, "issues.write");
    // Testers file and describe; assigning is triage work.
    if (args.assigneeId && !actor.canTriage)
      throw new ConvexError("Only issue triagers can assign an issue");
    return service.createIssue(ctx, args, actor);
  },
});

export const update = mutation({
  args: {
    issueId: v.id("issues"),
    title: v.optional(v.string()),
    description: nullableText,
    steps: nullableText,
    actual: nullableText,
    expected: nullableText,
    area: v.optional(v.string()),
    priority: v.optional(issuePriorityValidator),
    assigneeId: v.optional(v.union(v.id("profiles"), v.null())),
    externalRef: nullableText,
    milestone: nullableText,
  },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, { issueId, ...input }) => {
    const actor = await service.requireIssueActor(ctx, "issues.triage");
    return service.updateIssue(ctx, issueId, input, actor);
  },
});

/** Status change from the detail select, or a drag on the board (with anchors). */
export const move = mutation({
  args: {
    issueId: v.id("issues"),
    status: issueStatusValidator,
    beforeId: v.optional(v.id("issues")),
    afterId: v.optional(v.id("issues")),
  },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    const actor = await service.requireIssueActor(ctx, "issues.triage");
    return service.moveIssue(ctx, args, actor);
  },
});

export const archive = mutation({
  args: { issueId: v.id("issues") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await service.requireIssueActor(ctx, "issues.manage");
    await service.archiveIssue(ctx, args.issueId, actor);
    return null;
  },
});

export const restore = mutation({
  args: { issueId: v.id("issues") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await service.requireIssueActor(ctx, "issues.manage");
    await service.restoreIssue(ctx, args.issueId, actor);
    return null;
  },
});

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await service.requireIssueActor(ctx, "issues.write");
    return ctx.storage.generateUploadUrl();
  },
});

export const addComment = mutation({
  args: {
    issueId: v.id("issues"),
    body: v.string(),
    uploads: v.optional(v.array(issueUploadValidator)),
  },
  returns: v.id("issueComments"),
  handler: async (ctx, args) => {
    const actor = await service.requireIssueActor(ctx, "issues.write");
    return service.addComment(ctx, args, actor);
  },
});

export const updateComment = mutation({
  args: { commentId: v.id("issueComments"), body: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await service.requireIssueActor(ctx, "issues.write");
    await service.updateComment(ctx, args, actor);
    return null;
  },
});

export const deleteComment = mutation({
  args: { commentId: v.id("issueComments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await service.requireIssueActor(ctx, "issues.write");
    await service.deleteComment(ctx, args.commentId, actor);
    return null;
  },
});

export const removeAttachment = mutation({
  args: { attachmentId: v.id("issueAttachments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await service.requireIssueActor(ctx, "issues.write");
    await service.removeAttachment(ctx, args.attachmentId, actor);
    return null;
  },
});
