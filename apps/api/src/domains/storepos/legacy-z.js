/**
 * IP-SCPWD-CAP (feature 2): the version gate on the legacy "Z reading with no supervisor PIN" path.
 *
 * Phones on beta.26-29 send the day-end Z without a supervisor PIN; the server still accepts it from them (see
 * `store.read` in operations.js). Builds from beta.30 sign the Z with a PIN, so a no-PIN Z from one of those is a way around
 * the PIN. The gate refuses it:
 *   mode `older_builds_only` (default): refuse when the phone is known to be on the first PIN-capable build or later
 *       (it reported its build in `x-app-version-code`, or it has already sent a PIN-signed Z).
 *   mode `off`: refuse for every phone. The office switches this on when the report below shows nothing is left on old builds.
 * A phone that has never reported its build and never used a PIN is "unknown" and is still let through, so no old phone breaks.
 */
import { tx } from "@sunpride/db/client";
import { forbidden } from "../../core/errors.js";
import { roleHas } from "../../core/capabilities.js";
import { currentActor } from "../van/access.js";
import { choice, refuse, text } from "../van/model.js";

export const DEFAULT_MIN_VERSION = 30;
const REPORT_QUIET_DAYS = 45;

/** @param {any} db */
export async function legacyZGate(db) {
  const [row] = await db`select mode,min_version_code,note,effective_from from legacy_z_gate_settings
    where organization_id='sunpride' and effective_from<=now() order by effective_from desc,created_at desc limit 1`;
  return row
    ? {
        mode: /** @type {string} */ (row.mode),
        minVersionCode: Number(row.min_version_code),
        note: row.note ?? null,
        isDefault: false,
      }
    : {
        mode: "older_builds_only",
        minVersionCode: DEFAULT_MIN_VERSION,
        note: null,
        isDefault: true,
      };
}

/** Has this phone ever signed a Z reading with a supervisor PIN? (A PIN on a void or a drop does not prove the build can sign a Z.) @param {any} db @param {string} deviceId */
async function signedWithPin(db, deviceId) {
  const [row] = await db`select 1 as yes from store_overrides o join store_shifts s on s.id=o.shift_id
    where s.device_id=${deviceId} and o.kind='z_reading' and o.method in ('pin_offline','pin_online') limit 1`;
  return Boolean(row);
}

/**
 * Called by the store Z handler when the request carries no supervisor proof. Refuses (plain words, wire code
 * `unsupported_operation`) when the gate says this phone must use a PIN; otherwise returns and the legacy path runs.
 * @param {any} db @param {{id:string}} device
 */
export async function assertLegacyZAllowed(db, device) {
  const gate = await legacyZGate(db);
  if (gate.mode === "off")
    refuse(
      "The Z reading now needs a supervisor PIN on every till. Update the Sunpride app, then ask a supervisor to enter their PIN.",
      "unsupported_operation",
    );
  const [d] =
    await db`select app_version_code from registered_devices where id=${device.id}`;
  const version = d?.app_version_code == null ? null : Number(d.app_version_code);
  if (
    (version !== null && version >= gate.minVersionCode) ||
    (await signedWithPin(db, device.id))
  )
    refuse(
      "This app can sign the Z reading with a supervisor PIN. Ask a supervisor to enter their PIN for the Z reading.",
      "unsupported_operation",
    );
}

/** @param {number|null} version */
const buildWords = (version) => (version === null ? null : `beta.${version}`);

/**
 * The report: every store till (phone) and what it is running, so the office knows when the gate can go to "off".
 * @param {any} db @param {any} actor
 */
export async function legacyZReport(db, actor) {
  const gate = await legacyZGate(db);
  const rows = await db`select d.id,d.inventory_tag,d.app_version_code,d.app_version_name,d.app_version_seen_at,d.last_seen_at,d.status,
      p.name as person,r.name as register_name,l.name as store_name,m.mode,
      exists(select 1 from store_overrides o join store_shifts s on s.id=o.shift_id where s.device_id=d.id and o.kind='z_reading' and o.method in ('pin_offline','pin_online')) as signs_with_pin,
      (select max(o.captured_at) from store_overrides o join store_shifts s on s.id=o.shift_id where s.device_id=d.id and o.method='legacy_no_pin') as last_legacy_z,
      (select count(*)::int from store_overrides o join store_shifts s on s.id=o.shift_id where s.device_id=d.id and o.method='legacy_no_pin' and o.captured_at>now()-interval '30 days') as legacy_z_30d
    from registered_devices d
      join profiles p on p.id=d.profile_id
      left join pos_device_modes m on m.device_id=d.id and m.effective_to is null and m.effective_from<=now()
      left join store_registers r on r.id=m.register_id
      left join inventory_locations l on l.id=r.location_id
    where d.app='van-android' and d.status<>'revoked'
      and (m.mode='store' or exists(select 1 from store_overrides o join store_shifts s on s.id=o.shift_id where s.device_id=d.id and o.method='legacy_no_pin'))
    order by l.name nulls last,r.name nulls last,d.inventory_tag`;
  const now = Date.now();
  const devices = rows.map((/** @type {any} */ r) => {
    const version = r.app_version_code == null ? null : Number(r.app_version_code);
    const seen = r.last_seen_at ? new Date(r.last_seen_at).getTime() : null;
    const quiet = seen === null || now - seen > REPORT_QUIET_DAYS * 86400000;
    /** @type {"current"|"signs_with_pin"|"older"|"unknown"} */
    let state;
    if (version !== null)
      state = version >= gate.minVersionCode ? "current" : "older";
    else state = r.signs_with_pin ? "signs_with_pin" : "unknown";
    // A phone that has a build below the gate but also signed with a PIN is on a PIN-capable build.
    if (state === "older" && r.signs_with_pin) state = "signs_with_pin";
    const stateWords = {
      current: `On ${buildWords(version)} or later`,
      signs_with_pin: "Signs the Z with a PIN",
      older: `Older build (${buildWords(version)})`,
      unknown: "Build not reported yet",
    }[state];
    return {
      deviceId: r.id,
      tag: r.inventory_tag,
      person: r.person,
      store: r.store_name ?? null,
      register: r.register_name ?? null,
      mode: r.mode ?? null,
      status: r.status,
      buildCode: version,
      buildName: r.app_version_name ?? buildWords(version),
      buildSeenAt: r.app_version_seen_at ? new Date(r.app_version_seen_at).getTime() : null,
      lastSeenAt: seen,
      quiet,
      state,
      stateWords,
      needsUpdate: state === "older" || state === "unknown",
      lastLegacyZ: r.last_legacy_z ? new Date(r.last_legacy_z).getTime() : null,
      legacyZ30d: r.legacy_z_30d,
    };
  });
  const needing = devices.filter(
    (/** @type {any} */ d) => d.needsUpdate && !d.quiet,
  );
  const legacy30 = devices.reduce(
    (/** @type {number} */ n, /** @type {any} */ d) => n + d.legacyZ30d,
    0,
  );
  const safe = needing.length === 0 && legacy30 === 0;
  return {
    gate: {
      mode: gate.mode,
      modeWords:
        gate.mode === "off"
          ? "Off: the Z reading needs a supervisor PIN on every till"
          : `Older builds only: refused from beta.${gate.minVersionCode} and later, still allowed on older or unreported builds`,
      minVersionCode: gate.minVersionCode,
      note: gate.note,
      isDefault: gate.isDefault,
    },
    summary: {
      devices: devices.length,
      needingUpdate: needing.length,
      quietNeedingUpdate: devices.filter(
        (/** @type {any} */ d) => d.needsUpdate && d.quiet,
      ).length,
      legacyZLast30Days: legacy30,
      safeToSwitchOff: safe,
      advice: safe
        ? "Every active till is on a build that signs the Z with a PIN and none used the old way in 30 days. It is safe to switch the old way off."
        : needing.length
          ? `${needing.length} till${needing.length === 1 ? "" : "s"} still on an older or unreported build. Update ${needing.length === 1 ? "it" : "them"} first.`
          : `No till is on an old build, but the old way was used ${legacy30} time${legacy30 === 1 ? "" : "s"} in the last 30 days. Check who did it, then switch it off.`,
    },
    devices,
    canManage: roleHas(actor.role, "admin.manage"),
    quietDays: REPORT_QUIET_DAYS,
  };
}

/** @param {any} router @param {any} platform @param {(path:string,capability:string,work:(db:any,actor:any,body:any,c:any)=>Promise<any>,topics?:string[])=>any} command */
export function installLegacyZ(router, platform, command) {
  router.get("/api/v1/storepos/legacy-z", async (/** @type {any} */ c) =>
    tx(c.db, async (/** @type {any} */ db) => {
      const actor = await currentActor(db, c.actor);
      if (
        !roleHas(actor.role, "van.cash.approve") &&
        !roleHas(actor.role, "admin.manage")
      )
        throw forbidden("Supervisors and the office only");
      return legacyZReport(db, actor);
    }),
  );
  command(
    "legacy-z/gate",
    "admin.manage",
    async (/** @type {any} */ db, /** @type {any} */ actor, /** @type {any} */ b) => {
      const mode = choice(b.mode, ["older_builds_only", "off"]);
      const min = b.minVersionCode ?? DEFAULT_MIN_VERSION;
      if (!Number.isSafeInteger(min) || min < 1 || min > 999999)
        refuse("Enter the first app build that can sign the Z with a PIN (a whole number such as 30).");
      const [row] =
        await db`insert into legacy_z_gate_settings(mode,min_version_code,note,set_by) values(${mode},${min},${text(b.note, 300)},${actor.profileId}) returning id`;
      return { id: row.id };
    },
  );
}
