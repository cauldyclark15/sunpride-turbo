/** Bounded content checks for chat files: the declared MIME must match the bytes.
 * Signatures for images and PDF, the zip central directory for zip/Office files, and
 * strict UTF-8 without NUL for text. Never trusts the uploader's declaration alone. */

const OFFICE = /** @type {Record<string,string>} */ ({
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "word/",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xl/",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "ppt/",
});
const MAX_ZIP_ENTRIES = 20000;
const MAX_CENTRAL_DIR = 8 * 1024 * 1024;

/** @param {Uint8Array} b @param {number[]} sig @param {number} [at] */
const starts = (b, sig, at = 0) => sig.every((x, i) => b[at + i] === x);
/** @param {string} s */
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** Zip entry names from the central directory, or null when it is not a well-formed zip.
 * @param {import('bun').BunFile} file @param {number} size */
async function zipNames(file, size) {
  if (size < 22) return null;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!starts(head, [0x50, 0x4b, 0x03, 0x04]) && !starts(head, [0x50, 0x4b, 0x05, 0x06]))
    return null;
  const from = Math.max(0, size - 22 - 0xffff);
  const tail = Buffer.from(await file.slice(from, size).arrayBuffer());
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (tail.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) return null;
  const count = tail.readUInt16LE(end + 10),
    cdSize = tail.readUInt32LE(end + 12),
    cdOffset = tail.readUInt32LE(end + 16);
  if (
    count > MAX_ZIP_ENTRIES ||
    cdSize > MAX_CENTRAL_DIR ||
    cdOffset + cdSize > from + end
  )
    return null;
  const cd = Buffer.from(
    await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer(),
  );
  /** @type {string[]} */ const names = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) return null;
    const n = cd.readUInt16LE(p + 28),
      extra = cd.readUInt16LE(p + 30),
      comment = cd.readUInt16LE(p + 32);
    if (p + 46 + n > cd.length) return null;
    names.push(cd.toString("utf8", p + 46, p + 46 + n));
    p += 46 + n + extra + comment;
  }
  return names;
}

/** Strict UTF-8 with no NUL, streamed so a 25 MB file never sits in memory twice.
 * @param {import('bun').BunFile} file */
async function utf8Text(file) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.includes(0)) return false;
      decoder.decode(value, { stream: true });
    }
    decoder.decode();
    return true;
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

/** True when the stored bytes are really of the declared type.
 * @param {string} path @param {string} mime */
export async function contentMatches(path, mime) {
  const file = Bun.file(path);
  const size = file.size;
  if (!size) return false;
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  switch (mime) {
    case "image/jpeg":
      return starts(head, [0xff, 0xd8, 0xff]);
    case "image/png":
      return starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif":
      return starts(head, ascii("GIF87a")) || starts(head, ascii("GIF89a"));
    case "image/webp":
      return starts(head, ascii("RIFF")) && starts(head, ascii("WEBP"), 8);
    case "application/pdf":
      return starts(head, ascii("%PDF-"));
    case "application/zip":
      return (await zipNames(file, size)) !== null;
    case "text/plain":
    case "text/csv":
      return utf8Text(file);
  }
  const prefix = OFFICE[mime];
  if (!prefix) return false;
  const names = await zipNames(file, size);
  return (
    !!names &&
    names.includes("[Content_Types].xml") &&
    names.some((n) => n.startsWith(prefix))
  );
}
