import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import schema from "../schema";
import { normalizeEmail } from "../lib/access";
import { formatIssueKey, parseIssueKey } from "./constants";
import {
  activityValue,
  commentValue,
  issueCardValidator,
  nameResolver,
  readBoard,
  readDetail,
  toCard,
} from "./queries";
import * as service from "./service";
import { issuePriorityValidator, issueStatusValidator } from "./validators";

/**
 * Agent access without a browser. Internal functions only — callable from
 * `packages/backend` with `bunx convex run issues/agent:<fn> '<json>'` (deployment admin
 * key) or through `bun scripts/issues.ts`. Never exposed to web clients. Writes are
 * attributed to `actor` (default "Agent").
 */

const issueRef = v.union(v.number(), v.string());

async function findIssue(ctx: QueryCtx | MutationCtx, ref: string | number) {
  const number = parseIssueKey(ref);
  if (number === undefined)
    throw new ConvexError(`Not an issue number: ${ref}`);
  const issue = await ctx.db
    .query("issues")
    .withIndex("by_number", (q) => q.eq("number", number))
    .unique();
  if (!issue) throw new ConvexError(`${formatIssueKey(number)} not found`);
  return issue;
}

async function profileByEmail(ctx: MutationCtx, email: string) {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
    .unique();
  if (!profile) throw new ConvexError(`No profile for ${email}`);
  return profile._id;
}

export const list = internalQuery({
  args: {
    status: v.optional(issueStatusValidator),
    area: v.optional(v.string()),
    milestone: v.optional(v.string()),
    priority: v.optional(issuePriorityValidator),
    search: v.optional(v.string()),
    archived: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    issues: v.array(issueCardValidator),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const result = await readBoard(ctx, {
      archived: args.archived ?? false,
      status: args.status,
      area: args.area,
      milestone: args.milestone,
      priority: args.priority,
      search: args.search,
    });
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const name = nameResolver(ctx);
    const issues = await Promise.all(
      result.issues
        .sort((a, b) => a.number - b.number)
        .slice(0, limit)
        .map((issue) => toCard(issue, name)),
    );
    return {
      issues,
      truncated: result.truncated || result.issues.length > limit,
    };
  },
});

export const get = internalQuery({
  args: { number: issueRef },
  returns: v.object({
    issue: schema.doc("issues"),
    key: v.string(),
    reporterName: v.string(),
    assigneeName: v.optional(v.string()),
    comments: v.array(commentValue),
    activity: v.array(activityValue),
  }),
  handler: async (ctx, args) => {
    const issue = await findIssue(ctx, args.number);
    return readDetail(ctx, issue, { canManage: true });
  },
});

const createFields = {
  title: v.string(),
  description: v.optional(v.string()),
  steps: v.optional(v.string()),
  actual: v.optional(v.string()),
  expected: v.optional(v.string()),
  area: v.optional(v.string()),
  priority: v.optional(issuePriorityValidator),
  status: v.optional(issueStatusValidator),
  assigneeEmail: v.optional(v.string()),
  externalRef: v.optional(v.string()),
  milestone: v.optional(v.string()),
};

const createResult = v.object({
  issueId: v.id("issues"),
  number: v.number(),
  key: v.string(),
  created: v.boolean(),
  externalRef: v.optional(v.string()),
});

async function createOne(
  ctx: MutationCtx,
  input: {
    title: string;
    description?: string;
    steps?: string;
    actual?: string;
    expected?: string;
    area?: string;
    priority?: "low" | "medium" | "high" | "critical";
    status?: Parameters<typeof service.createIssue>[1]["status"];
    assigneeEmail?: string;
    externalRef?: string;
    milestone?: string;
  },
  actor: service.IssueActor,
) {
  const externalRef = service.cleanExternalRef(input.externalRef);
  if (externalRef) {
    const existing = await ctx.db
      .query("issues")
      .withIndex("by_externalRef", (q) => q.eq("externalRef", externalRef))
      .first();
    if (existing)
      return {
        issueId: existing._id,
        number: existing.number,
        key: formatIssueKey(existing.number),
        created: false,
        externalRef,
      };
  }
  const { assigneeEmail, ...fields } = input;
  const assigneeId: Id<"profiles"> | undefined = assigneeEmail
    ? await profileByEmail(ctx, assigneeEmail)
    : undefined;
  const created = await service.createIssue(
    ctx,
    { ...fields, externalRef, assigneeId },
    actor,
  );
  return { ...created, created: true, externalRef };
}

export const create = internalMutation({
  args: { ...createFields, actor: v.optional(v.string()) },
  returns: createResult,
  handler: async (ctx, { actor, ...input }) =>
    createOne(ctx, input, service.agentActor(actor)),
});

/** Idempotent on `externalRef`: an issue whose reference already exists is returned, not duplicated. */
export const bulkCreate = internalMutation({
  args: {
    issues: v.array(v.object(createFields)),
    actor: v.optional(v.string()),
  },
  returns: v.array(createResult),
  handler: async (ctx, args) => {
    if (args.issues.length > 100)
      throw new ConvexError("Send at most 100 issues per call");
    const actor = service.agentActor(args.actor);
    const results = [];
    for (const input of args.issues)
      results.push(await createOne(ctx, input, actor));
    return results;
  },
});

export const update = internalMutation({
  args: {
    number: issueRef,
    status: v.optional(issueStatusValidator),
    priority: v.optional(issuePriorityValidator),
    assigneeEmail: v.optional(v.union(v.string(), v.null())),
    title: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    steps: v.optional(v.union(v.string(), v.null())),
    actual: v.optional(v.union(v.string(), v.null())),
    expected: v.optional(v.union(v.string(), v.null())),
    area: v.optional(v.string()),
    externalRef: v.optional(v.union(v.string(), v.null())),
    milestone: v.optional(v.union(v.string(), v.null())),
    comment: v.optional(v.string()),
    actor: v.optional(v.string()),
  },
  returns: v.object({ key: v.string(), changed: v.boolean() }),
  handler: async (
    ctx,
    { number, status, assigneeEmail, comment, actor: label, ...fields },
  ) => {
    const actor = service.agentActor(label);
    const issue = await findIssue(ctx, number);
    const assigneeId =
      assigneeEmail === undefined
        ? undefined
        : assigneeEmail === null
          ? null
          : await profileByEmail(ctx, assigneeEmail);
    const updated = await service.updateIssue(
      ctx,
      issue._id,
      { ...fields, assigneeId },
      actor,
    );
    const moved = status
      ? await service.moveIssue(ctx, { issueId: issue._id, status }, actor)
      : { changed: false };
    if (comment?.trim())
      await service.addComment(
        ctx,
        { issueId: issue._id, body: comment },
        actor,
      );
    return {
      key: formatIssueKey(issue.number),
      changed: updated.changed || moved.changed || Boolean(comment?.trim()),
    };
  },
});

export const comment = internalMutation({
  args: { number: issueRef, body: v.string(), actor: v.optional(v.string()) },
  returns: v.object({ key: v.string(), commentId: v.id("issueComments") }),
  handler: async (ctx, args) => {
    const issue = await findIssue(ctx, args.number);
    const commentId = await service.addComment(
      ctx,
      { issueId: issue._id, body: args.body },
      service.agentActor(args.actor),
    );
    return { key: formatIssueKey(issue.number), commentId };
  },
});
