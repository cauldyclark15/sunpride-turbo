import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { verifyDeviceProof } from "./devices.js";
import { ApiError, forbidden, invalid, unauthenticated } from "./errors.js";
import { hooks } from "./hooks.js";
import { readBearer } from "./context.js";
import {
  HEX64_RE,
  isPlainObject,
  isUuid,
  randomToken,
  sha256Hex,
} from "./util.js";

/**
 * Evidence bytes (D6): a device-proved claim reserves a stable blob row; the raw PUT streams
 * bytes under the upload capability with a hard size cap and a SHA-256 check.
 */

export const MEDIA_PURPOSES = Object.freeze([
  "visit-photo",
  "truck-damage",
  "prospect-photo",
  "attendance-photo",
]);
export const MEDIA_MIMES = Object.freeze(["image/jpeg"]);
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const UPLOAD_TTL_MS = 10 * 60 * 1000;

/** @param {Record<string,string|undefined>} env */
export function filesDir(env) {
  const dir = env.FILES_DIR || join(homedir(), "sunpride-data", "files");
  return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}

/** @param {import('./context.js').Ctx} ctx */
function publicOrigin(ctx) {
  if (ctx.env.PUBLIC_ORIGIN) return ctx.env.PUBLIC_ORIGIN.replace(/\/$/, "");
  const proto = ctx.req.headers.get("x-forwarded-proto");
  const host =
    ctx.req.headers.get("x-forwarded-host") ?? ctx.req.headers.get("host");
  return host
    ? `${proto ?? ctx.url.protocol.replace(":", "")}://${host}`
    : ctx.url.origin;
}

/** @param {import('./context.js').Ctx} ctx */
async function claim(ctx) {
  ctx.v2 = true;
  const body = ctx.body;
  if (!isPlainObject(body) || body.version !== 2)
    throw new ApiError(
      "version_unsupported",
      426,
      "Protocol version 2 required",
      false,
      { action: "update" },
    );
  const { purpose, ownerId, mime, size, sha256 } = body;
  if (typeof purpose !== "string" || !MEDIA_PURPOSES.includes(purpose))
    throw invalid("Invalid purpose");
  if (!(ownerId === null || isUuid(ownerId))) throw invalid("Invalid ownerId");
  if (purpose !== "truck-damage" && ownerId === null)
    throw invalid("visit-photo needs ownerId");
  if (typeof mime !== "string" || !MEDIA_MIMES.includes(mime))
    throw invalid("Unsupported media type", "unsupported_media");
  if (
    !Number.isSafeInteger(size) ||
    /** @type {number} */ (size) < 1 ||
    /** @type {number} */ (size) > MAX_MEDIA_BYTES
  )
    throw invalid("Invalid size");
  if (typeof sha256 !== "string" || !HEX64_RE.test(sha256))
    throw invalid("Invalid sha256");
  const device = await verifyDeviceProof(ctx);
  const actor = /** @type {import('./context.js').Actor} */ (ctx.actor);
  if (
    !(await hooks.canClaimMedia(ctx.db, actor, {
      purpose,
      ownerId: /** @type {string|null} */ (ownerId),
      deviceId: device.id,
    }))
  )
    throw forbidden("Not allowed to upload for this owner", "out_of_scope");
  const token = randomToken("spu_");
  const expiresAt = Date.now() + UPLOAD_TTL_MS;
  // Same subject/purpose/owner/digest → same stable blob id across reissued claims.
  const [row] = await ctx.db`
    insert into files (owner_id, purpose, sha256, mime, size, device_id, created_by, upload_token_hash, upload_expires_at)
    values (${ownerId}, ${purpose}, ${sha256}, ${mime}, ${size}, ${device.id}, ${actor.userId}, ${sha256Hex(token)}, ${new Date(expiresAt)})
    on conflict (created_by, purpose, owner_id, sha256) do update
      set upload_token_hash = excluded.upload_token_hash, upload_expires_at = excluded.upload_expires_at
    returning id, mime, size`;
  if (row.mime !== mime || Number(row.size) !== size)
    throw invalid("Digest already claimed with another size or type");
  return {
    version: 2,
    uploadId: row.id,
    uploadToken: token,
    uploadUrl: `${publicOrigin(ctx)}/api/media/uploads/${row.id}`,
    expiresAt,
  };
}

/** @param {import('./context.js').Ctx} ctx */
async function upload(ctx) {
  ctx.v2 = true;
  const uploadId = ctx.params.uploadId;
  if (!isUuid(uploadId)) throw invalid("Invalid upload id");
  const token = readBearer(ctx.req);
  if (!token?.startsWith("spu_"))
    throw unauthenticated("Upload token required", "upload_unauthorized");
  const rows = await ctx.db`
    select * from files where id = ${uploadId} and upload_token_hash = ${sha256Hex(token)} and upload_expires_at > now()`;
  const file = rows[0];
  if (!file)
    throw unauthenticated(
      "Upload token expired or invalid",
      "upload_unauthorized",
    );
  const contentType = ctx.req.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== file.mime)
    throw invalid("Content-Type does not match the claim", "unsupported_media");
  const size = Number(file.size);
  const declared = ctx.req.headers.get("content-length");
  if (declared !== null && Number(declared) !== size)
    throw invalid("Content-Length does not match the claim", "size_mismatch");
  const root = filesDir(ctx.env);
  const tmpDir = join(root, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `${uploadId}.${crypto.randomUUID()}`);
  const hasher = new Bun.CryptoHasher("sha256");
  const sink = Bun.file(tmpPath).writer();
  let total = 0;
  try {
    if (!ctx.req.body) throw invalid("Empty body", "size_mismatch");
    const reader = ctx.req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > size) {
        await reader.cancel().catch(() => {});
        throw new ApiError(
          "payload_too_large",
          413,
          "Upload is larger than claimed",
        );
      }
      hasher.update(value);
      sink.write(value);
    }
    await sink.end();
    if (total !== size)
      throw invalid("Upload size does not match the claim", "size_mismatch");
    const digest = hasher.digest("hex");
    if (digest !== file.sha256)
      throw invalid(
        "Upload checksum does not match the claim",
        "checksum_mismatch",
      );
    const dir = join(root, digest.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const finalPath = join(dir, digest);
    await rename(tmpPath, finalPath); // content-addressed: identical bytes overwrite identically
    const relPath = `${digest.slice(0, 2)}/${digest}`;
    await ctx.db`
      update files set status = 'stored', path = ${relPath}, stored_at = coalesce(stored_at, now())
      where id = ${uploadId}`;
    return {
      version: 2,
      blobId: uploadId,
      sha256: digest,
      status: "stored",
      serverTime: Date.now(),
    };
  } catch (error) {
    try {
      await sink.end();
    } catch {}
    await rm(tmpPath, { force: true });
    throw error;
  }
}

/** @param {import('./router.js').Router} router */
export function installMedia(router) {
  router.post("/api/media/claims", claim, { v2: true });
  router.put("/api/media/uploads/:uploadId", upload, { v2: true, raw: true });
}
