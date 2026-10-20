import { text, refuse } from "./model.js";

// SEAM(SAP): preserve the existing replica credit decision until SAP's owned adapter lands.
export { creditCheck as sapCreditCheck } from "../orders/pricing.js";
// SEAM(FISCAL): existing context-bound office code validation, NOT a new override authority.
export { consumeApproval as requestOverride } from "./approvals.js";

/** SEAM(FISCAL): accept an immutable number already allocated by the encrypted handset counter.
 * FISCAL replaces this with reserved-series verification; this adapter NEVER invents a fiscal series.
 * @param {{tripNumber:string,provided:unknown}} input
 */
export function allocateDocumentNumber({ tripNumber, provided }) {
  const number = text(provided, 100, true);
  if (
    !number ||
    !number.startsWith(tripNumber + "-") ||
    !/^.+-[0-9A-F]{8}-\d{4,9}$/.test(number)
  )
    refuse(
      "Document number does not match the offline trip allocation",
      "invalid_request",
    );
  return number;
}
