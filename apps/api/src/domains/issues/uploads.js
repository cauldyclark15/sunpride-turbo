import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tx } from "@sunpride/db/client";
import { requireCapability } from "../../core/capabilities.js";
import { filesDir, UPLOAD_TTL_MS } from "../../core/media.js";
import { readBearer } from "../../core/context.js";
import { ApiError, invalid, forbidden } from "../../core/errors.js";
import { readCapped } from "../../core/router.js";
import {
  HEX64_RE,
  isPlainObject,
  randomToken,
  sha256Hex,
} from "../../core/util.js";
import { validateAttachment } from "./constants.js";
import { findIssue, uuid, videoLimit, requireIssueAccess } from "./service.js";

export const CHUNK_BYTES = 8 * 1024 * 1024;
/** @param {import('../../core/router.js').Router} router */
export function installUploads(router) {
  // Web/agent claim: same platform files + upload token, without a native-device proof.
  router.post("/api/v1/issues/uploads/claim", async (ctx) => {
    ctx.v2 = false;
    const actor = await requireCapability(ctx, "issues.write");
    const b = ctx.body;
    if (
      !isPlainObject(b) ||
      typeof b.mime !== "string" ||
      typeof b.sha256 !== "string" ||
      !HEX64_RE.test(b.sha256) ||
      !Number.isSafeInteger(b.size) ||
      Number(b.size) < 1
    )
      throw invalid("Invalid media claim");
    const size = Number(b.size),
      mime = b.mime.toLowerCase(),
      sha256 = b.sha256;
    const error = validateAttachment({
      fileType: mime,
      fileSize: size,
      maxVideoBytes: videoLimit(actor),
    });
    if (error) throw invalid(error);
    const ownerId = b.ownerId == null ? null : uuid(b.ownerId, "owner");
    const token = randomToken("spu_");
    const expiresAt = Date.now() + UPLOAD_TTL_MS;
    const id = await tx(ctx.db, async (db) => {
      if (ownerId) requireIssueAccess(await findIssue(db, ownerId), actor);
      const [f] =
        await db`insert into files (owner_id,purpose,sha256,mime,size,created_by,upload_token_hash,upload_expires_at)
        values (${ownerId},'issue-attachment',${sha256},${mime},${size},${actor.userId},${sha256Hex(token)},${new Date(expiresAt)})
        on conflict (created_by,purpose,owner_id,sha256) do update set upload_token_hash=excluded.upload_token_hash,upload_expires_at=excluded.upload_expires_at returning *`;
      if (f.mime !== mime || Number(f.size) !== size)
        throw invalid("Digest already claimed with another size or type");
      return f.id;
    });
    return {
      uploadId: id,
      uploadToken: token,
      uploadUrl: `/api/media/uploads/${id}`,
      chunkUrl: `/api/v1/issues/uploads/${id}/chunks`,
      chunkBytes: CHUNK_BYTES,
      expiresAt,
    };
  });
  // Core has a 16 MiB HTTP cap. Larger issue documents/videos use bounded chunks,
  // then the exact same content-addressed platform files store and digest checks.
  router.put(
    "/api/v1/issues/uploads/:uploadId/chunks/:index",
    async (ctx) => {
      ctx.v2 = false;
      const id = uuid(ctx.params.uploadId, "upload");
      const index = Number(ctx.params.index);
      if (!Number.isSafeInteger(index) || index < 0)
        throw invalid("Invalid chunk index");
      const token = readBearer(ctx.req);
      if (!token?.startsWith("spu_")) throw forbidden("Upload token required");
      return tx(ctx.db, async (db) => {
        const [f] =
          await db`select * from files where id=${id} and purpose='issue-attachment' and upload_token_hash=${sha256Hex(token)} and upload_expires_at>now() for update`;
        if (!f) throw forbidden("Upload token expired or invalid");
        const count = Math.ceil(Number(f.size) / CHUNK_BYTES);
        if (index >= count) throw invalid("Invalid chunk index");
        const expected =
          index === count - 1
            ? Number(f.size) - index * CHUNK_BYTES
            : CHUNK_BYTES;
        if (ctx.req.headers.get("content-type") !== f.mime)
          throw invalid("Content-Type does not match the claim");
        const bytes = await readCapped(ctx.req, expected);
        if (bytes.length !== expected)
          throw invalid("Upload size does not match the claim");
        if (f.status === "stored")
          return { blobId: id, status: "stored", sha256: f.sha256 };
        const root = filesDir(ctx.env),
          dir = join(root, "issue-chunks", id);
        await mkdir(dir, { recursive: true });
        const part = join(dir, String(index));
        if (await Bun.file(part).exists()) {
          if (
            sha256Hex(new Uint8Array(await Bun.file(part).arrayBuffer())) !==
            sha256Hex(bytes)
          )
            throw new ApiError(
              "conflict",
              409,
              "Chunk already uploaded with different bytes",
            );
        } else await Bun.write(part, bytes);
        for (let n = 0; n < count; n++)
          if (!(await Bun.file(join(dir, String(n))).exists()))
            return { uploadId: id, received: index, status: "pending" };
        const temp = join(dir, "complete"),
          sink = Bun.file(temp).writer(),
          hash = new Bun.CryptoHasher("sha256");
        try {
          for (let n = 0; n < count; n++) {
            const b = new Uint8Array(
              await Bun.file(join(dir, String(n))).arrayBuffer(),
            );
            hash.update(b);
            sink.write(b);
          }
          await sink.end();
          if (hash.digest("hex") !== f.sha256) {
            await rm(dir, { recursive: true, force: true });
            throw invalid("Upload checksum does not match the claim");
          }
          await mkdir(join(root, f.sha256.slice(0, 2)), { recursive: true });
          const path = `${f.sha256.slice(0, 2)}/${f.sha256}`;
          await rename(temp, join(root, path));
          await db`update files set status='stored',path=${path},stored_at=coalesce(stored_at,now()) where id=${id}`;
          await rm(dir, { recursive: true, force: true });
          return { blobId: id, status: "stored", sha256: f.sha256 };
        } catch (e) {
          try {
            await sink.end();
          } catch {}
          throw e;
        }
      });
    },
    { raw: true },
  );
  router.get(
    "/api/v1/issues/attachments/:attachmentId/content",
    async (ctx) => {
      ctx.v2 = false;
      const actor = await requireCapability(ctx, "issues.read");
      const id = uuid(ctx.params.attachmentId, "attachment");
      const [f] =
        await ctx.db`select a.issue_id,a.file_name,f.path,f.mime from issue_attachments a join files f on f.id=a.storage_id join issue_comments c on c.id=a.comment_id where a.id=${id} and c.deleted_at is null and f.status='stored'`;
      if (f)
        requireIssueAccess(await findIssue(ctx.db, f.issue_id, false), actor);
      if (!f?.path)
        throw new ApiError("not_found", 404, "Attachment not found");
      const file = Bun.file(join(filesDir(ctx.env), f.path));
      if (!(await file.exists()))
        throw new ApiError("not_found", 404, "Attachment bytes are missing");
      const headers = new Headers({
        "content-type": f.mime,
        "content-disposition": `${f.mime.startsWith("image/") || f.mime.startsWith("video/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.file_name)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "accept-ranges": "bytes",
      });
      const range = ctx.req.headers.get("range");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const start = match?.[1]
          ? Number(match[1])
          : Math.max(0, file.size - Number(match?.[2]));
        const end =
          match?.[1] && match[2]
            ? Math.min(file.size - 1, Number(match[2]))
            : file.size - 1;
        if (
          !match ||
          (!match[1] && !match[2]) ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start >= file.size ||
          end < start
        ) {
          headers.set("content-range", `bytes */${file.size}`);
          return new Response(null, { status: 416, headers });
        }
        headers.set("content-range", `bytes ${start}-${end}/${file.size}`);
        headers.set("content-length", String(end - start + 1));
        return new Response(file.slice(start, end + 1), {
          status: 206,
          headers,
        });
      }
      return new Response(file, { headers });
    },
  );
}
