import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { requireNationalScope } from "../lib/scope";

const heartbeat = v.object({
  _id: v.id("connectorHeartbeats"),
  _creationTime: v.number(),
  connectorId: v.string(),
  status: v.union(
    v.literal("online"),
    v.literal("degraded"),
    v.literal("offline"),
  ),
  adapter: v.string(),
  lastSeenAt: v.number(),
  details: v.optional(v.string()),
});
export const connectorHealth = query({
  args: {},
  returns: v.array(heartbeat),
  handler: async (ctx) => {
    await requireCapability(ctx, "integration.read");
    await requireNationalScope(ctx, ["admin", "operations"]);
    return ctx.db.query("connectorHeartbeats").take(20);
  },
});
