import { ApiError } from "../../core/errors.js";
import { sha256Hex } from "../../core/util.js";
import { text } from "../orders/validation.js";
/** F-306 F-307: preserve the exact, bounded original bytes for PO and contract evidence.
 * @param {any} value */
export function originalDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError("invalid_request", 400, "A source document is required");
  const filename = text(value.filename, "Filename", 160),
    contentBase64 = value.contentBase64;
  if (typeof contentBase64 !== "string" || contentBase64.length > 600_000)
    throw new ApiError("invalid_request", 400, "Document must be under 450 KB");
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.toString("base64") !== contentBase64 || !bytes.length)
    throw new ApiError("invalid_request", 400, "Document encoding is invalid");
  return { filename, contentBase64, bytes, hash: sha256Hex(bytes) };
}
