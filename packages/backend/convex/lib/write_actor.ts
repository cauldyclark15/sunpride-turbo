import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { interval, prospective } from "../org/validation";
import { type Capability, requireCapability } from "./capabilities";

/**
 * Who performs an effective-dated master-data write.
 *
 * - `user`: a signed-in person calling a public mutation. The writer gates every scope with
 *   the person's capabilities and accepts only future-effective changes.
 * - `system`: a trusted internal mutation (today only the beta sample seed, SP-0129). It is
 *   recorded under `subject` as the actor, skips the per-person capability gates and may
 *   write a record that is already in force, but every integrity rule of the writer still
 *   runs (parent/owner/route coverage, overlaps, sequences, plan locks, audit, projections).
 *
 * Public mutations always pass `USER_ACTOR`; a `system` actor is never reachable from a client.
 */
export type WriteActor = { kind: "user" } | { kind: "system"; subject: string };

export const USER_ACTOR: WriteActor = { kind: "user" };

/** The capability gate for a user; the system subject for a trusted internal writer. */
export async function authorizeWrite(
  ctx: MutationCtx,
  actor: WriteActor,
  capability: Capability,
  targetUnitId?: Id<"orgUnits">,
): Promise<string> {
  if (actor.kind === "system") return actor.subject;
  const { identity } = await requireCapability(ctx, capability, targetUnitId);
  return identity.tokenIdentifier;
}

/** Users may only schedule future changes; the system writer may start a record now or earlier. */
export function assertEffectiveStart(actor: WriteActor, from: number) {
  if (actor.kind === "system") interval(from);
  else prospective(from);
}
