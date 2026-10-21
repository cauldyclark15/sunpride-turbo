import {
  pbkdf2Sync,
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { refuse } from "../van/model.js";
/** F-R07: PIN never enters an outbox, receipt or audit; bootstrap carries only its one-way verifier.
 * @param {string} pin */
export function pinSettings(pin) {
  if (!/^\d{6,12}$/.test(pin)) refuse("Use a 6–12 digit supervisor PIN");
  const salt = randomBytes(16).toString("hex");
  const key = pbkdf2Sync(pin, salt, 160000, 32, "sha256");
  return {
    salt,
    key: key.toString("hex"),
    hash: createHash("sha256").update(key).digest("hex"),
  };
}
/** @param {any} policy @param {string} pin */
export function verifyPin(policy, pin) {
  if (!policy?.pin_hash || !/^\d{6,12}$/.test(pin ?? ""))
    refuse("Supervisor PIN is required");
  const hash = createHash("sha256")
    .update(pbkdf2Sync(pin, policy.pin_salt, 160000, 32, "sha256"))
    .digest();
  if (!timingSafeEqual(hash, Buffer.from(policy.pin_hash, "hex")))
    refuse("Supervisor PIN was not accepted");
}
/** F-R07: possession of the downloaded hash cannot sign a discount.
 * @param {any} policy @param {any} p */
export function verifyDiscountProof(policy, p) {
  if (
    !policy?.pin_key ||
    typeof p.employeeProof !== "string" ||
    !/^[a-f0-9]{64}$/.test(p.employeeProof)
  )
    refuse("Supervisor verification is required");
  const message = `${p.saleId}|${p.shiftId}|${p.totalCentavos}|${policy.id}`;
  const expected = createHmac("sha256", Buffer.from(policy.pin_key, "hex"))
    .update(message)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(p.employeeProof, "hex")))
    refuse("Supervisor verification was not accepted");
}
