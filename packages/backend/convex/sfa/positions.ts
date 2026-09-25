import { v } from "convex/values";
import { query } from "../_generated/server";
import schema from "../schema";
import { requireCapability } from "../lib/capabilities";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";

const positionValue = schema.doc("positions");
const standardValue = schema.doc("positionStandards");

/** Active positions, for the admin persona picker. */
export const list = query({
  args: {},
  returns: v.array(positionValue),
  handler: async (ctx) => {
    await requireCapability(ctx, "admin.manage");
    return ctx.db
      .query("positions")
      .withIndex("by_organizationId_and_active", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("active", true),
      )
      .take(100);
  },
});

/** The standards recorded for one position, newest first. */
export const standards = query({
  args: { positionId: v.id("positions") },
  returns: v.array(standardValue),
  handler: async (ctx, args) => {
    await requireCapability(ctx, "admin.manage");
    return ctx.db
      .query("positionStandards")
      .withIndex("by_positionId_and_effectiveFrom", (q) =>
        q.eq("positionId", args.positionId),
      )
      .order("desc")
      .take(50);
  },
});
