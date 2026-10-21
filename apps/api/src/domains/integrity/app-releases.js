import { tx } from "@sunpride/db/client";
import { currentActor } from "../van/access.js";
import { forbidden, invalid, conflict, notFound } from "../../core/errors.js";
import { isUuid, sha256Hex } from "../../core/util.js";
import { artifactPath, inspectApk, stagedApks } from "./apk-artifacts.js";

/** @param {any} c */
async function admin(c) {
  const actor = await currentActor(c.db, c.actor);
  if (actor.role !== "super_admin") throw forbidden();
  return actor;
}
/** @param {any} r */
function release(r) {
  return {
    id: r.id,
    app: r.app,
    packageName: r.package_name,
    versionCode: Number(r.version_code),
    versionName: r.version_name,
    sha256: r.sha256,
    signerSha256: r.signer_sha256,
    sizeBytes: Number(r.size_bytes),
    notes: r.release_notes,
    effectiveFrom: new Date(r.effective_from).getTime(),
    withdrawn: r.withdrawn_at !== null,
  };
}
/** F-006: one private distribution channel for existing apps, no sideload URL or trust assertion from clients.
 * @param {any} router @param {any} platform */
export function installAppReleases(router, platform) {
  router.get("/api/v1/integrity/app-releases", async (/** @type {any} */ c) => {
    await admin(c);
    const rows =
      await c.db`select * from app_releases order by created_at desc limit 101`;
    return {
      staged: await stagedApks(platform.env),
      releases: rows.slice(0, 100).map(release),
      truncated: rows.length > 100,
    };
  });
  router.post(
    "/api/v1/integrity/app-releases/publish",
    async (/** @type {any} */ c) => {
      const actor = await admin(c),
        b = c.body;
      if (
        typeof b.sha256 !== "string" ||
        typeof b.notes !== "string" ||
        !b.notes.trim() ||
        b.notes.length > 1000 ||
        !Number.isSafeInteger(b.effectiveFrom) ||
        b.effectiveFrom < Date.now() - 60_000 ||
        b.effectiveFrom > Date.now() + 366 * 86400_000
      )
        throw invalid(
          "Choose a staged APK, release notes and a prospective effective time",
        );
      const path = await artifactPath(platform.env, b.sha256),
        m = await inspectApk(path, platform.env);
      if (m.sha256 !== b.sha256) throw invalid("Staged APK content changed");
      return tx(c.db, async (db) => {
        await db`select set_config('sunpride.actor',${actor.userId},true)`;
        const [r] =
          await db`insert into app_releases(app,package_name,version_code,version_name,sha256,signer_sha256,size_bytes,release_notes,effective_from,published_by) values(${m.app},${m.packageName},${m.versionCode},${m.versionName},${m.sha256},${m.signerSha256},${m.sizeBytes},${b.notes.trim()},${new Date(b.effectiveFrom)},${actor.profileId}) on conflict(package_name,version_code) do nothing returning *`;
        const existing =
          r ??
          (
            await db`select * from app_releases where package_name=${m.packageName} and version_code=${m.versionCode}`
          )[0];
        if (
          existing.sha256 !== m.sha256 ||
          existing.release_notes !== b.notes.trim()
        )
          throw conflict(
            "This version is already published with different bytes or notes",
          );
        return release(existing);
      });
    },
  );
  router.post(
    "/api/v1/integrity/app-releases/withdraw",
    async (/** @type {any} */ c) => {
      const actor = await admin(c);
      if (!isUuid(c.body.id)) throw invalid();
      return tx(c.db, async (db) => {
        await db`select set_config('sunpride.actor',${actor.userId},true)`;
        const [r] =
          await db`update app_releases set withdrawn_at=coalesce(withdrawn_at,now()) where id=${c.body.id} returning *`;
        if (!r) throw notFound();
        return release(r);
      });
    },
  );
  router.get("/api/v1/app-releases/latest", async (/** @type {any} */ c) => {
    await currentActor(c.db, c.actor);
    const pkg = c.url.searchParams.get("packageName"),
      version = Number(c.url.searchParams.get("versionCode"));
    if (
      c.via !== "access" ||
      !c.session?.deviceKeyId ||
      !pkg ||
      !/^com\.sunpride\.(field|van)\.(dev|beta|staging|prod)$/.test(pkg) ||
      !Number.isSafeInteger(version) ||
      version < 0
    )
      throw invalid();
    const [r] =
      await c.db`select * from app_releases where app=${c.session.app} and package_name=${pkg} and version_code>${version} and withdrawn_at is null and effective_from<=now() and (effective_to is null or effective_to>now()) order by version_code desc limit 1`;
    return { release: r ? release(r) : null };
  });
  router.get("/api/v1/app-releases/:id/apk", async (/** @type {any} */ c) => {
    await currentActor(c.db, c.actor);
    if (c.via !== "access" || !c.session?.deviceKeyId || !isUuid(c.params.id))
      throw forbidden();
    const [r] =
      await c.db`select * from app_releases where id=${c.params.id} and app=${c.session.app} and withdrawn_at is null and effective_from<=now() and (effective_to is null or effective_to>now())`;
    if (!r) throw notFound();
    const file = Bun.file(await artifactPath(platform.env, r.sha256));
    if (
      file.size !== Number(r.size_bytes) ||
      sha256Hex(new Uint8Array(await file.arrayBuffer())) !== r.sha256
    )
      throw conflict("Release artifact changed; ask the office to withdraw it");
    return new Response(file, {
      headers: {
        "content-type": "application/vnd.android.package-archive",
        "content-length": String(file.size),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
