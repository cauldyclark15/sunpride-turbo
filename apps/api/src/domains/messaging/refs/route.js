import { resolveType, searchType } from "./common.js";
export const type = "route";
/** @param {any} db @param {any} actor @param {string[]} ids */
export const resolve = (db, actor, ids) => resolveType(db, actor, ids, type);
/** @param {any} db @param {any} actor @param {string} q @param {number} limit */
export const search = (db, actor, q, limit) =>
  searchType(db, actor, q, limit, type);
