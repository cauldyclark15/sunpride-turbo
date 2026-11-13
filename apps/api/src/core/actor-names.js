// Display names for the people (or automatic jobs) recorded on a document.
// Actor columns such as requested_by / decided_by usually hold a user uuid, but automatic jobs write a
// "system:<job>" subject (e.g. van/loadout.js writes "system:van-plan"). Only uuids are looked up in profiles;
// casting a system subject to uuid would fail the whole read. System subjects get a readable label instead.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @type {Record<string,string>} */
const SYSTEM_LABELS = {
  "system:van-plan": "Van plan (automatic)",
  "system:sap": "SAP (automatic)",
  "system:callflow-boundary": "Day close (automatic)",
  "system:default": "Standard setting",
};

/** @param {unknown} id */
export function isUserId(id) {
  return typeof id === "string" && UUID.test(id);
}

/** Readable label for a non-user actor, or null when the id is a user uuid / empty. @param {unknown} id */
export function systemActorName(id) {
  if (typeof id !== "string" || !id || isUserId(id)) return null;
  if (SYSTEM_LABELS[id]) return SYSTEM_LABELS[id];
  if (id.startsWith("system:")) {
    const job = id.slice(7).replace(/[-_]+/g, " ").trim();
    return job ? `${job.charAt(0).toUpperCase()}${job.slice(1)} (automatic)` : "Automatic";
  }
  return null;
}

/**
 * Map of actor id -> display name for every id given. User uuids resolve through profiles; system
 * subjects resolve to a readable label; anything else is left out (callers show it as unknown).
 * @param {any} db @param {Array<string|null|undefined>} actorIds
 * @returns {Promise<Map<string,string|null>>}
 */
export async function actorNames(db, actorIds) {
  /** @type {Map<string,string|null>} */ const out = new Map();
  const users = [];
  for (const id of new Set(actorIds.filter(Boolean))) {
    if (isUserId(id)) users.push(id);
    else {
      const label = systemActorName(id);
      if (label) out.set(/** @type {string} */ (id), label);
    }
  }
  if (users.length) {
    const rows = await db`select user_id,name from profiles where user_id in ${db(users)}`;
    for (const r of rows) out.set(r.user_id, r.name);
  }
  return out;
}
