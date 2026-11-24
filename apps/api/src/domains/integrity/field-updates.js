import { timingSafeEqual } from "node:crypto";
import { tx } from "@sunpride/db/client";
import { readBearer } from "../../core/context.js";
import { forbidden, invalid, conflict } from "../../core/errors.js";
import { sha256Hex } from "../../core/util.js";

const PACKAGE = /^com\.sunpride\.field\.(dev|beta|staging|prod)$/;
/** Only public, stable download locations controlled by the publisher. @param {unknown} value */
export function fieldDownloadUrl(value) {
  if (typeof value !== "string" || value.length > 1000) throw invalid();
  let u;
  try {
    u = new URL(value);
  } catch {
    throw invalid("Choose a secure download link");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    u.port ||
    !(
      (u.hostname === "drive.google.com" &&
        /^\/file\/d\/[A-Za-z0-9_-]+\/view$/.test(u.pathname) &&
        !u.search) ||
      (u.hostname === "sunpride.cauldnclark.com" &&
        /^\/downloads\/[A-Za-z0-9._/-]+\.apk$/.test(u.pathname) &&
        !u.search)
    )
  )
    throw invalid("Choose the published Sunpride download link");
  return value;
}
/** @param {any} row */
function view(row) {
  return {
    app: row.app,
    package_name: row.package_name,
    version_code: row.version_code,
    version_name: row.version_name,
    download_url: row.download_url,
    minimum_supported_version_code: row.minimum_supported_version_code,
    notes: row.notes,
    git_sha: row.git_sha,
  };
}
/** Isolated publisher credential: never grants normal user or chat access. @param {any} c */
function publisher(c) {
  if (c.actor?.role === "super_admin") return c.actor.profileId;
  const expected = c.env.SP_APP_RELEASE_TOKEN?.trim();
  const given = readBearer(c.req);
  if (
    !expected ||
    expected.length < 32 ||
    !given ||
    !timingSafeEqual(
      Buffer.from(sha256Hex(expected)),
      Buffer.from(sha256Hex(given)),
    )
  )
    throw forbidden();
  return "system:app-publisher";
}
/** SP-0245: implements the existing release job's notify + read-back contract. @param {any} router */
export function installFieldUpdates(router) {
  router.post("/api/v1/apps/releases", async (/** @type {any} */ c) => {
    const actor = publisher(c),
      b = c.body;
    const pkg = b?.package_name ?? "com.sunpride.field.beta";
    if (
      b?.app !== "field" ||
      !PACKAGE.test(pkg) ||
      !Number.isSafeInteger(b.version_code) ||
      b.version_code <= 0 ||
      b.version_code > 2147483647 ||
      typeof b.version_name !== "string" ||
      !b.version_name.trim() ||
      b.version_name.length > 100 ||
      typeof b.notes !== "string" ||
      b.notes.length > 1000 ||
      typeof b.git_sha !== "string" ||
      !/^[a-f0-9]{40}$/.test(b.git_sha) ||
      (b.minimum_supported_version_code !== undefined &&
        (!Number.isSafeInteger(b.minimum_supported_version_code) ||
          b.minimum_supported_version_code < 0 ||
          b.minimum_supported_version_code > b.version_code))
    )
      throw invalid("Supply a version and its published download link");
    const url = fieldDownloadUrl(b.download_url);
    return tx(c.db, async (db) => {
      await db`select pg_advisory_xact_lock(hashtext(${`field-update:${pkg}`}))`;
      const [existing] =
        await db`select * from field_app_updates where package_name=${pkg} and version_code=${b.version_code}`;
      if (existing) {
        if (
          existing.version_name !== b.version_name ||
          existing.download_url !== url ||
          existing.notes !== b.notes ||
          existing.git_sha !== b.git_sha ||
          (b.minimum_supported_version_code !== undefined &&
            existing.minimum_supported_version_code !==
              b.minimum_supported_version_code)
        )
          throw conflict(
            "This version was already announced with different details",
          );
        return { ...view(existing), notified: 0 };
      }
      const [prior] =
        await db`select * from field_app_updates where package_name=${pkg} order by version_code desc limit 1`;
      // A routine new build never makes the preceding version incompatible. Preserve an explicit compatibility floor.
      const minimum =
        b.minimum_supported_version_code ??
        prior?.minimum_supported_version_code ??
        0;
      if (minimum > b.version_code)
        throw invalid("An older version cannot replace the supported update");
      const [row] =
        await db`insert into field_app_updates(app,package_name,version_code,version_name,download_url,minimum_supported_version_code,notes,git_sha,publisher)
        values('field',${pkg},${b.version_code},${b.version_name},${url},${minimum},${b.notes},${b.git_sha},${actor}) returning *`;
      return { ...view(row), notified: 0 };
    });
  });
  // Public metadata lets even an obsolete or signed-out app find its replacement. No credentials or customer data.
  router.get("/api/v1/apps/latest", async (/** @type {any} */ c) => {
    const pkg =
      c.url.searchParams.get("packageName") ?? "com.sunpride.field.beta";
    if (c.url.searchParams.get("app") !== "field" || !PACKAGE.test(pkg))
      throw invalid();
    const [row] =
      await c.db`select * from field_app_updates where package_name=${pkg} order by version_code desc limit 1`;
    return new Response(JSON.stringify(row ? view(row) : { release: null }), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });
}
