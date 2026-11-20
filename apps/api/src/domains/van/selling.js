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

/** Enabled modes, in menu order. Selling remains Sales-only (the owner keeps all modes).
 * @param {{app_mode?: unknown, app_modes?: unknown, selling?: unknown, role?: unknown}|null|undefined} p
 * @returns {("mapping"|"visits"|"selling")[]} */
export function appModesFor(p) {
  if (p?.role === "super_admin") return [...APP_MODES];
  const stored = Array.isArray(p?.app_modes)
    ? p.app_modes
    : [p?.app_mode ?? "mapping"];
  const modes = APP_MODES.filter(
    (m) => stored.includes(m) && (m !== "selling" || sellingFor(p)),
  );
  return modes.length
    ? modes
    : [stored.includes("selling") ? "visits" : "mapping"];
}

/** Legacy default, constrained to the person's currently enabled modes.
 * @param {{app_mode?: unknown, app_modes?: unknown, selling?: unknown, role?: unknown}|null|undefined} p
 * @returns {"mapping"|"visits"|"selling"} */
export function appModeFor(p) {
  const modes = appModesFor(p);
  return modes.find((m) => m === p?.app_mode) ?? modes[0];
}

/** Remove Truck selling on an effective role change, preserving every other enabled mode.
 * @param {{app_mode?: unknown, app_modes?: unknown, selling?: unknown, role?: unknown}} p
 * @param {string} role */
export function appModeRoleChange(p, role) {
  if (role === "sales" || role === "super_admin") return {};
  const modes = appModesFor({ ...p, role });
  return {
    app_modes: modes,
    app_mode: appModeFor({ ...p, role }),
    selling: false,
  };
}

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
    ? await db`select selling,role,app_mode,app_modes from profiles where id=${profileId} and deleted_at is null`
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
