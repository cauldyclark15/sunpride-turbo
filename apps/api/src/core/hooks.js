/**
 * Cross-lane seams. Other lanes replace the DEFAULT bodies below (or call `setHooks` from
 * their install) — core never reads domain tables directly.
 *
 * @typedef {{ id: string, userId: string, name: string|null, role: string, orgUnitId: string|null,
 *   status: 'active'|'disabled'|string, scopeEpoch?: string|null }} HookProfile
 * @typedef {import('./context.js').Actor} Actor
 * @typedef {import('@sunpride/db/client').Db} Db
 */

const defaults = {
  /**
   * Pending (not revoked) invitation for this normalized email. People lane fills this.
   * @param {Db} _db @param {string} _email @returns {Promise<boolean>}
   */
  async isEmailInvited(_db, _email) {
    return false;
  },
  /**
   * Profile for a login user. Identity lane fills this.
   * @param {Db} _db @param {string} _userId @returns {Promise<HookProfile|null>}
   */
  async loadProfile(_db, _userId) {
    return null;
  },
  /**
   * Is `unitId` inside the actor's current org subtree? Org lane fills this; the default
   * only admits the actor's own unit.
   * @param {Db} _db @param {Actor} actor @param {string} unitId @returns {Promise<boolean>}
   */
  async unitInScope(_db, actor, unitId) {
    return Boolean(actor.orgUnitId) && actor.orgUnitId === unitId;
  },
  /**
   * The actor's current subtree unit ids (for /api/me scope). Org lane fills this.
   * @param {Db} _db @param {Actor} actor @returns {Promise<string[]>}
   */
  async scopeUnitIds(_db, actor) {
    return actor.orgUnitId ? [actor.orgUnitId] : [];
  },
  /**
   * The active national root unit id, or null. Org lane fills this.
   * @param {Db} _db @returns {Promise<string|null>}
   */
  async rootUnitId(_db) {
    return null;
  },
  /**
   * Topic grant for /ws subscribe. Defaults to topics registered with `registerTopic`.
   * @param {Actor} actor @param {string} topic @returns {Promise<boolean>|boolean}
   */
  canSubscribe(actor, topic) {
    for (const [prefix, check] of topicGrants)
      if (topic === prefix || topic.startsWith(`${prefix}:`))
        return check(actor, topic);
    return false;
  },
  /**
   * May this actor claim an upload for purpose/owner? Visits/van lanes fill this.
   * @param {Db} _db @param {Actor} _actor @param {{purpose: string, ownerId: string|null, deviceId: string}} _claim
   * @returns {Promise<boolean>}
   */
  async canClaimMedia(_db, _actor, _claim) {
    return true;
  },
};

/** @type {Map<string, (actor: Actor, topic: string) => boolean|Promise<boolean>>} */
const topicGrants = new Map();

/**
 * Register a ws topic family (`issues` matches `issues` and `issues:*`).
 * @param {string} prefix
 * @param {(actor: Actor, topic: string) => boolean|Promise<boolean>} check
 */
export function registerTopic(prefix, check) {
  topicGrants.set(prefix, check);
}

/** @type {typeof defaults} */
export const hooks = { ...defaults };

/** @param {Partial<typeof defaults>} partial */
export function setHooks(partial) {
  Object.assign(hooks, partial);
}

export function resetHooks() {
  Object.assign(hooks, defaults);
  topicGrants.clear();
}

/** @param {Db} db @param {string} email */
export const isEmailInvited = (db, email) => hooks.isEmailInvited(db, email);
/** @param {Db} db @param {string} userId */
export const loadProfile = (db, userId) => hooks.loadProfile(db, userId);
/** @param {Db} db @param {Actor} actor @param {string} unitId */
export const unitInScope = (db, actor, unitId) =>
  hooks.unitInScope(db, actor, unitId);
/** @param {Actor} actor @param {string} topic */
export const canSubscribe = (actor, topic) => hooks.canSubscribe(actor, topic);
