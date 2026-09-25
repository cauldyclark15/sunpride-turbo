import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { VisitAck } from "../visits/commands";
import type { AuthorizedDevice } from "./types";

type Kind = Doc<"processedMobileOperations">["kind"];

/** Canonicalize validated command fields, independent of JSON property insertion order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  throw new ConvexError("invalid_request");
}

export async function payloadHash(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(payload)),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function findOrExecute(
  ctx: MutationCtx,
  args: {
    organizationId: string;
    kind: Kind;
    key: string;
    actor: AuthorizedDevice;
    canonicalPayload: unknown;
    execute: () => Promise<VisitAck>;
  },
): Promise<
  | { status: "accepted"; ack: VisitAck }
  | { status: "conflict"; code: "conflict" }
> {
  const hash = await payloadHash(args.canonicalPayload);
  const rows = await ctx.db
    .query("processedMobileOperations")
    .withIndex("by_organizationId_and_kind_and_clientRequestId", (q) =>
      q
        .eq("organizationId", args.organizationId)
        .eq("kind", args.kind)
        .eq("clientRequestId", args.key),
    )
    .take(2);
  if (rows.length > 1) throw new ConvexError("conflict");
  const existing = rows[0];
  if (existing) {
    if (
      existing.profileId !== args.actor.profileId ||
      existing.deviceId !== args.actor.deviceId ||
      existing.payloadHash !== hash
    )
      return { status: "conflict", code: "conflict" };
    return { status: "accepted", ack: existing.result };
  }
  // Domain writes, event/change, and registry insert share this mutation transaction.
  // Never catch execute errors here: Convex must roll back the whole transaction.
  const ack = await args.execute();
  await ctx.db.insert("processedMobileOperations", {
    organizationId: args.organizationId,
    kind: args.kind,
    clientRequestId: args.key,
    profileId: args.actor.profileId,
    deviceId: args.actor.deviceId,
    payloadHash: hash,
    result: ack,
    serverAt: ack.serverTime,
  });
  return { status: "accepted", ack };
}
