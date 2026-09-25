import type { Id } from "../_generated/dataModel";
import type { AppRole } from "../lib/roles";

/** A request already proven to come from an active registered device bound to this person. */
export type AuthorizedDevice = {
  deviceId: Id<"registeredDevices">;
  profileId: Id<"profiles">;
  /** Full identity.tokenIdentifier (issuer|subject). */
  subject: string;
  orgUnitId: Id<"orgUnits">;
  role: AppRole;
  scopeFingerprint: string;
};
