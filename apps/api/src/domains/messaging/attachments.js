import { join } from "node:path";
import jpeg from "jpeg-js";
import { notFound, unauthenticated } from "../../core/errors.js";
import {
  MESSAGING_MIMES,
  MESSAGING_MAX_BYTES,
  MESSAGING_THUMB_MAX_BYTES,
  UPLOAD_TTL_MS,
  filesDir,
  publicOrigin,
  upload,
} from "../../core/media.js";
import { randomToken, sha256Hex, HEX64_RE } from "../../core/util.js";
import { contentMatches } from "./content.js";
import {
  gate,
  invalid,
  uuid,
  text,
  iso,
  write,
  messageAccess,
} from "./model.js";

/** @param {any} db @param {any} actor @param {string} id */
async function access(db, actor, id) {
  uuid(id);
  const [a] =
    await db`select a.*,m.conversation_id,m.deleted_at,f.path,f.status,f.upload_token_hash from chat_attachments a join files f on f.id=a.blob_id left join chat_messages m on m.id=a.message_id where a.id=${id}`;
  if (!a) throw notFound();
  if (a.message_id) {
    await messageAccess(db, actor, a.message_id);
    if (a.deleted_at) throw notFound();
  } else if (a.uploader_user_id !== actor.userId) throw notFound();
  return a;
}
/** @param {any} db @param {any} row @param {string[]} ids */
export async function bindAttachments(db, row, ids) {
  if (new Set(ids).size !== ids.length) throw invalid("Duplicate attachment");
  for (const id of ids) {
    uuid(id);
    const a = await access(db, { userId: row.author_user_id }, id);
    if (
      a.role !== "file" ||
      a.message_id ||
      a.uploader_user_id !== row.author_user_id ||
      a.status !== "stored" ||
      // Still holding its upload link: the finish step (content check) has not run.
      a.upload_token_hash
    )
      throw invalid("Attachment is not ready or not yours");
    const thumbs =
      await db`select a.*,f.status,f.upload_token_hash from chat_attachments a join files f on f.id=a.blob_id where of_attachment_id=${id}`;
    for (const t of thumbs)
      if (t.status !== "stored" || t.upload_token_hash || !t.width || !t.height)
        throw invalid("Thumbnail is not ready");
    await db`update chat_attachments set message_id=${row.id} where id=${id} or of_attachment_id=${id}`;
    await db`update files set upload_token_hash=null,upload_expires_at=null where id in(select blob_id from chat_attachments where id=${id} or of_attachment_id=${id})`;
  }
}
/** @param {any} db @param {string} message */
export async function attachments(db, message) {
  const rows =
    await db`select a.*,t.id as thumb_id from chat_attachments a left join chat_attachments t on t.of_attachment_id=a.id
  where a.message_id=${message} and a.role='file' order by a.created_at,a.id`;
  return rows.map((/** @type {any} */ a) => ({
    id: a.id,
    name: a.name,
    mime: a.mime,
    bytes: Number(a.bytes),
    width: a.width,
    height: a.height,
    url: `/api/v1/messaging/attachments/${a.id}`,
    thumb_url: a.thumb_id
      ? `/api/v1/messaging/attachments/${a.id}/thumb`
      : null,
    kind: a.mime.startsWith("image/") ? "image" : "file",
  }));
}
/** @param {import('../../core/router.js').Router} router */
export function installAttachments(router) {
  router.post("/api/v1/messaging/attachments/claim", async (c) => {
    const a = await gate(c),
      b = c.body;
    if (!b || !["file", "thumb"].includes(b.role))
      throw invalid("Invalid attachment role");
    text(b.name, 255);
    if (/[\x00-\x1f\x7f/\\]/.test(b.name)) throw invalid("Invalid file name");
    if (
      !MESSAGING_MIMES.includes(b.mime) ||
      !Number.isSafeInteger(b.bytes) ||
      b.bytes < 1 ||
      b.bytes >
        (b.role === "thumb"
          ? MESSAGING_THUMB_MAX_BYTES
          : MESSAGING_MAX_BYTES) ||
      typeof b.sha256 !== "string" ||
      !HEX64_RE.test(b.sha256)
    )
      throw invalid("Unsupported file type, size or digest");
    if (b.role === "thumb" && (b.mime !== "image/jpeg" || !b.of_attachment_id))
      throw invalid("Thumbnail must be a JPEG linked to a file");
    if (b.role === "file" && b.of_attachment_id != null)
      throw invalid("Files cannot be thumbnails");
    const id = crypto.randomUUID(),
      token = randomToken("spu_"),
      expires = new Date(Date.now() + UPLOAD_TTL_MS);
    await write(c.db, async (db) => {
      if (b.role === "thumb") {
        const parent = await access(db, a, uuid(b.of_attachment_id));
        if (
          parent.role !== "file" ||
          parent.message_id ||
          parent.uploader_user_id !== a.userId
        )
          throw invalid("Choose your unsent attachment");
        if (
          (
            await db`select id from chat_attachments where of_attachment_id=${parent.id}`
          ).length
        )
          throw invalid("A thumbnail already exists");
      }
      const [f] =
        await db`insert into files(owner_id,purpose,sha256,mime,size,created_by,upload_token_hash,upload_expires_at)
    values(${id},${b.role === "thumb" ? "messaging-thumb" : "messaging-file"},${b.sha256},${b.mime},${b.bytes},${a.userId},${sha256Hex(token)},${expires}) returning id`;
      await db`insert into chat_attachments(id,uploader_user_id,blob_id,role,of_attachment_id,name,mime,bytes,sha256)
    values(${id},${a.userId},${f.id},${b.role},${b.of_attachment_id ?? null},${b.name},${b.mime},${b.bytes},${b.sha256})`;
    });
    return {
      attachment_id: id,
      upload_url: `${publicOrigin(c)}/api/v1/messaging/attachments/${id}/upload?token=${token}`,
      expires_at: iso(expires),
    };
  });
  router.put(
    "/api/v1/messaging/attachments/:id/upload",
    async (c) => {
      c.v2 = false;
      const id = uuid(c.params.id),
        token = c.url.searchParams.get("token");
      // The URL itself is the capability: a single-use, short-lived token bound to
      // this uploader's claim (size, mime, digest). No session or bearer is needed.
      const refused = () =>
        unauthenticated("Upload link expired or invalid", "upload_unauthorized");
      if (!token?.startsWith("spu_")) throw refused();
      const tokenHash = sha256Hex(token);
      /** @param {any} db */
      const current = async (db) => {
        const [a] =
          await db`select a.*,f.upload_token_hash,f.upload_expires_at,f.path from chat_attachments a join files f on f.id=a.blob_id where a.id=${id}`;
        if (
          !a ||
          a.message_id ||
          a.upload_token_hash !== tokenHash ||
          new Date(a.upload_expires_at).getTime() <= Date.now()
        )
          throw refused();
        return a;
      };
      const a = await current(c.db);
      // Stream on the pool, outside the chat write lock: a slow 25 MB upload must not
      // hold every sender. The core uploader re-checks this token, the claimed size
      // and the SHA-256, so the stored bytes can only ever be the claimed content.
      const req = new Request(c.req, { headers: new Headers(c.req.headers) });
      req.headers.set("authorization", `Bearer ${token}`);
      let result;
      try {
        result = await upload({ ...c, req, params: { uploadId: a.blob_id } });
      } finally {
        c.v2 = false;
      }
      // Check that the bytes really are the declared type, outside the lock (the path is
      // content-addressed by the claimed digest, so it cannot change underneath us).
      const [stored] =
        await c.db`select path from files where id=${a.blob_id} and status='stored'`;
      const matches =
        a.role === "thumb" ||
        (!!stored?.path &&
          (await contentMatches(join(filesDir(c.env), stored.path), a.mime)));
      // Finish under the same mutation boundary as send: content and thumbnail checks,
      // then the link is spent (single use). Binding requires a spent link, so nothing
      // can bind bytes that have not passed these checks.
      return write(c.db, async (db) => {
        const row = await current(db);
        if (!matches) {
          await db`update files set status='pending',path=null,stored_at=null,upload_token_hash=null,upload_expires_at=null where id=${row.blob_id}`;
          return { refusal: "File content does not match its type" };
        }
        if (row.role === "thumb") {
          let decoded = null;
          try {
            decoded = jpeg.decode(
              new Uint8Array(
                await Bun.file(join(filesDir(c.env), row.path)).arrayBuffer(),
              ),
              { maxResolutionInMP: 1, maxMemoryUsageInMB: 16 },
            );
          } catch {}
          if (!decoded || Math.max(decoded.width, decoded.height) > 320) {
            // Not a usable thumbnail: leave it unstored, exactly as before the PUT.
            await db`update files set status='pending',path=null,stored_at=null where id=${row.blob_id}`;
            return { refusal: decoded ? "Thumbnail must be at most 320 pixels" : "Invalid JPEG thumbnail" };
          }
          await db`update chat_attachments set width=${decoded.width},height=${decoded.height} where id=${id}`;
        }
        await db`update files set upload_token_hash=null,upload_expires_at=null where id=${row.blob_id}`;
        return { attachment_id: id, status: result.status };
      }).then((/** @type {any} */ done) => {
        if ("refusal" in done) throw invalid(String(done.refusal));
        return done;
      });
    },
    { raw: true },
  );
  for (const thumb of [false, true])
    router.get(
      `/api/v1/messaging/attachments/:id${thumb ? "/thumb" : ""}`,
      async (c) => {
        const a = await gate(c);
        let file = await access(c.db, a, c.params.id);
        if (thumb) {
          const [t] =
            await c.db`select id from chat_attachments where of_attachment_id=${file.id} and role='thumb'`;
          if (!t) throw notFound();
          file = await access(c.db, a, t.id);
        }
        if (file.status !== "stored" || !file.path) throw notFound();
        return new Response(Bun.file(join(filesDir(c.env), file.path)), {
          headers: {
            "content-type": file.mime,
            "content-disposition": `${file.mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        });
      },
    );
}
