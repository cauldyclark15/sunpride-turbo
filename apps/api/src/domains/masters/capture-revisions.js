import { canonicalJson } from "../../core/util.js";
import { ApiError } from "../../core/errors.js";
import { ORG_LOCK } from "../org/identity.js";
import { uuid, integer } from "../org/model.js";
import { customerEditAccess } from "./customer-edit.js";
import { readCustomer, saveCustomer } from "./customers.js";

/** Include all canonical facts, not an HTTP timestamp, so an office edit or approval
 * cannot be overwritten by an old phone. @param {any} value */
function fingerprint(value) {
  const { updatedAt, ...facts } = value;
  return new Bun.CryptoHasher("sha256")
    .update(canonicalJson(facts))
    .digest("hex");
}

/** The signed census writer already reauthorizes the current person and device.
 * Serial revisions are independent immutable operations, never edits of sent bytes.
 * @param {any} c @param {any} p @param {()=>Promise<any>} create @param {(id:string)=>Promise<void>} amend */
export async function captureRevision(c, p, create, amend) {
  if (p.customerDraftId === undefined) return create(); // older phones
  const id = uuid(p.customerDraftId);
  const revision = integer(p.draftRevision, 1, 1000000);
  await c.db`select pg_advisory_xact_lock(${ORG_LOCK})`;
  await c.db`select pg_advisory_xact_lock(4310420)`;
  const [prior] =
    await c.db`select * from customer_capture_revisions where profile_id=${c.actor.profileId} and draft_id=${id} for update`;
  let result;
  if (!prior) {
    if (revision !== 1)
      throw new ApiError(
        "conflict",
        409,
        "Reopen this customer before saving again.",
      );
    result = await create();
  } else {
    // Authorization precedes every revision/replay check.
    await customerEditAccess(c, prior.outlet_id, true);
    const customer = await readCustomer(c.db, prior.outlet_id);
    if (
      revision !== prior.revision + 1 ||
      fingerprint(customer) !== prior.customer_hash
    )
      throw new ApiError(
        "conflict",
        409,
        "The office changed this customer. Your phone copy is kept for review.",
      );
    await amend(prior.outlet_id);
    await saveCustomer(
      c,
      { customer: p.customer },
      { outletId: prior.outlet_id, fieldCapture: true },
    );
    result = { entityId: prior.outlet_id, eventIds: [] };
  }
  const customer = await readCustomer(c.db, result.entityId);
  await c.db`insert into customer_capture_revisions(profile_id,draft_id,outlet_id,revision,customer_hash)
    values(${c.actor.profileId},${id},${result.entityId},${revision},${fingerprint(customer)})
    on conflict(profile_id,draft_id) do update set revision=excluded.revision,customer_hash=excluded.customer_hash`;
  c.publish("outlets");
  c.publish("masters");
  return result;
}
