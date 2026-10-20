import { isPlainObject, isUuid } from "../../core/util.js";
import { ApiError } from "../../core/errors.js";

/** F-607/F-608 reject malformed JSON and identifiers before SQL; never repair tokens.
 * @param {unknown} body @returns {Record<string,any>} */
export function inputObject(body) {
  if (!isPlainObject(body))
    throw new ApiError(
      "invalid_request",
      400,
      "Provide an object with the command fields.",
    );
  return body;
}
/** @param {unknown} value @returns {string} */
export function uuidInput(value) {
  if (!isUuid(value))
    throw new ApiError(
      "invalid_reference",
      400,
      "Provide a valid record reference.",
    );
  return /** @type {string} */ (value);
}
