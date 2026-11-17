/**
 * SP-0191: the ONE place that decides whether a registered phone counts as a van phone on the van paths.
 *
 * - A Van app phone (`van-android`) always counts (unchanged).
 * - A Field app phone (`field-android`) counts only while its owner has Selling switched on in Setup > People and
 *   still holds the `sales` role. Selling is never effective for any other role, even if the stored flag is on,
 *   except (SP-0193) `super_admin`: the system owner always sells, with no switch to flip.
 * - Nothing else counts (iOS, web, office apps).
 *
 * Store POS (`storepos/**`, `pos_device_modes`, legacy Z) is NOT a van path and stays Van-app-only: it uses
 * `currentStoreDeviceActor` in `./access.js`, never this helper.
 */

export const VAN_APP = "van-android";
export const FIELD_APP = "field-android";

/** The one Selling rule for a profile row (role + stored switch). @param {{selling?: unknown, role?: unknown}|null|undefined} p */
export const sellingFor = (p) =>
  Boolean(p && (p.role === "super_admin" || (p.selling && p.role === "sales")));

/** SP-0194: the Field app modes the office picks per person (Setup > People > App mode). `mapping` is the default. */
export const APP_MODES = /** @type {const} */ ([
  "mapping",
  "visits",
  "selling",
]);

/** The mode the phone should show for a profile row. A stored `selling` mode only counts while the Selling rule above
 * says this person sells (a Sales person moved to another role falls back to Field visits, today's app minus Sell);
 * an unknown value reads as the default. super_admin keeps the stored value (they may switch on the phone).
 * @param {{app_mode?: unknown, selling?: unknown, role?: unknown}|null|undefined} p
 * @returns {"mapping"|"visits"|"selling"} */
export function appModeFor(p) {
  const stored = APP_MODES.find((m) => m === p?.app_mode) ?? "mapping";
  if (stored === "selling" && !sellingFor(p)) return "visits";
  return stored;
}

/** Modes this person may use on the phone: every mode for super_admin, otherwise just their one mode.
 * @param {{app_mode?: unknown, selling?: unknown, role?: unknown}|null|undefined} p */
export const appModesFor = (p) =>
  p?.role === "super_admin" ? [...APP_MODES] : [appModeFor(p)];

/** Is Selling effective for this person right now? @param {any} db @param {string|null|undefined} profileId */
export async function sellingOn(db, profileId) {
  if (!profileId) return false;
  const [p] =
    await db`select selling,role from profiles where id=${profileId} and deleted_at is null`;
  return sellingFor(p);
}

/** SP-0194: what the Field app's `/api/me` profile carries: Selling, App mode and the modes the person may use.
 * @param {any} db @param {string|null|undefined} profileId */
export async function fieldAppProfile(db, profileId) {
  const [p] = profileId
    ? await db`select selling,role,app_mode from profiles where id=${profileId} and deleted_at is null`
    : [];
  return {
    selling: sellingFor(p),
    appMode: appModeFor(p),
    modes: appModesFor(p),
  };
}

/** @param {any} db @param {{app?:string, profile_id?:string|null}|null|undefined} device */
export async function isSellingDevice(db, device) {
  if (!device) return false;
  if (device.app === VAN_APP) return true;
  if (device.app !== FIELD_APP) return false;
  return sellingOn(db, device.profile_id);
}

/** SQL condition (alias `d` = registered_devices, needs no join) for "this device counts as a van phone".
 * @param {any} db */
export const sellingDeviceSql = (db) =>
  db`(d.app=${VAN_APP} or (d.app=${FIELD_APP} and exists(select 1 from profiles sp where sp.id=d.profile_id and (sp.role='super_admin' or (sp.selling and sp.role='sales')) and sp.deleted_at is null)))`;

/** What the office sees for a phone in van lists: the tag, the person, and which app. @param {{label?:string|null, person?:string|null, app?:string}} d */
export function sellingDeviceName(d) {
  const tag = d.label || "Phone";
  const who = d.person ? ` · ${d.person}` : "";
  return `${tag}${who}${d.app === FIELD_APP ? " (Field app)" : ""}`;
}
