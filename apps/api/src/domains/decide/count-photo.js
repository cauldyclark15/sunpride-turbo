import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { filesDir, MAX_MEDIA_BYTES } from "../../core/media.js";
import { readCapped } from "../../core/router.js";
import { isUuid } from "../../core/util.js";
import { canClaimInventoryMedia } from "../inventory/media.js";

/**
 * IP-NAV: the web count screen's photo picker. A browser cannot make the device-proved media claim the phone makes, so the
 * counter uploads the JPEG here (raw body, `?sessionId=`), the same content-addressed way the bad-order office upload works,
 * under the `count-finding` purpose with the count as owner. The answer is the file id the count line takes as `photoFileId`.
 * Only the person counting (or the one it is assigned to) while the count is open, exactly the phone's claim rule.
 * @param {any} ctx
 */
export async function uploadCountPhoto(ctx) {
  const actor = await requireCapability(ctx, "inventory.count.submit");
  const sessionId = ctx.url.searchParams.get("sessionId");
  if (!isUuid(sessionId))
    throw new ApiError("invalid_request", 422, "Open the count first, then add the photo");
  if (!(await canClaimInventoryMedia(ctx.db, actor, { purpose: "count-finding", ownerId: sessionId, deviceId: "web" })))
    throw new ApiError("forbidden", 403, "Only the person counting can add photos to this count while it is open");
  const bytes = await readCapped(ctx.req, MAX_MEDIA_BYTES);
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
    throw new ApiError("photo_unreadable", 422, "That file is not a photo. Take the photo again.");
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const rel = `${digest.slice(0, 2)}/${digest}`;
  const root = filesDir(ctx.env);
  await mkdir(join(root, digest.slice(0, 2)), { recursive: true });
  const tmp = join(root, `${digest}.${crypto.randomUUID()}.part`);
  await Bun.write(tmp, bytes);
  await rename(tmp, join(root, rel));
  const [file] = await ctx.db`insert into files (owner_id,purpose,sha256,mime,size,path,status,created_by,stored_at)
    values (${sessionId},'count-finding',${digest},'image/jpeg',${bytes.byteLength},${rel},'stored',${actor.userId},now())
    on conflict (created_by,purpose,owner_id,sha256) do update set status='stored',path=excluded.path,stored_at=coalesce(files.stored_at,now())
    returning id`;
  return { fileId: file.id, sha256: digest, size: bytes.byteLength };
}
