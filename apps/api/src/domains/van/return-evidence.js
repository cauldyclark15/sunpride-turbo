import { invalid } from "../../core/errors.js";
import { sha256Hex } from "../../core/util.js";
import { routePolicy } from "./route-policy.js";
import { text } from "./model.js";

/** F-113 inline bounded evidence commits atomically with the return, so uncertain transport never loses it.
 * @param {any} db @param {any} trip @param {any} p
 */
export async function validateReturnEvidence(db, trip, p) {
  const policy = await routePolicy(db, trip, "return_reasons", p.deviceTime);
  for (const line of p.lines ?? []) {
    if (
      !policy.facts.items.some((/** @type {any} */ r) => r.code === line.reason)
    )
      throw invalid("Choose the effective shared return reason");
    text(line.lotNumber, 80, true);
  }
  const ack = p.customerAcknowledgement;
  text(ack?.name, 100, true);
  if (
    ack?.accepted !== true ||
    !Array.isArray(ack.strokes) ||
    ack.strokes.length < 1 ||
    ack.strokes.length > 30
  )
    throw invalid("Customer name and signature are required");
  let points = 0;
  for (const stroke of ack.strokes) {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > 1000)
      throw invalid("Capture a customer signature");
    for (const point of stroke) {
      points++;
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        point.some(
          (/** @type {any} */ n) =>
            !Number.isSafeInteger(n) || n < 0 || n > 10000,
        )
      )
        throw invalid("Invalid signature coordinates");
    }
  }
  if (points > 2000) throw invalid("Signature has too many points");
  const photo = p.photo;
  if (
    typeof photo?.base64 !== "string" ||
    photo.base64.length > 48000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(photo.base64)
  )
    throw invalid("Take a return evidence photo");
  const bytes = Buffer.from(photo.base64, "base64");
  if (
    bytes.length < 100 ||
    bytes.length > 32000 ||
    bytes.toString("base64") !== photo.base64 ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes[2] !== 255 ||
    bytes.at(-2) !== 255 ||
    bytes.at(-1) !== 217 ||
    sha256Hex(bytes) !== photo.sha256
  )
    throw invalid("Return evidence photo is invalid");
}
