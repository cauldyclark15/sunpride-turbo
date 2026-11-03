import type { MessagingClient } from "./client";

/** MESSAGING_V2 "Attachments": the only mimes the server accepts. */
export const IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;
export const DOCUMENT_MIMES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  zip: "application/zip",
} as const;
const EXTENSION_MIMES: Record<string, string> = {
  ...DOCUMENT_MIMES,
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};
const ALLOWED = new Set<string>([
  ...IMAGE_MIMES,
  ...Object.values(DOCUMENT_MIMES),
]);

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_THUMB_BYTES = 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const THUMB_MAX_SIDE = 320;

/** The file picker's `accept` list. */
export const ATTACHMENT_ACCEPT = [
  ...ALLOWED,
  ...Object.keys(EXTENSION_MIMES).map((ext) => `.${ext}`),
].join(",");

/**
 * Browsers report some types inconsistently (Windows sends CSV as an Excel
 * type and ZIP as `x-zip-compressed`); the extension decides those.
 */
export function attachmentMime(file: { name: string; type: string }): string {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = file.type.toLowerCase();
  if (ALLOWED.has(type)) return type;
  return EXTENSION_MIMES[ext] ?? type;
}

export function isImageMime(mime: string) {
  return (IMAGE_MIMES as readonly string[]).includes(mime);
}

/** A readable reason the file cannot be sent, or null when it can. */
export function attachmentError(file: {
  name: string;
  type: string;
  size: number;
}): string | null {
  if (!ALLOWED.has(attachmentMime(file)))
    return `${file.name} can't be sent. Use an image, PDF, Word, Excel, PowerPoint, CSV, text or ZIP file.`;
  if (file.size > MAX_FILE_BYTES)
    return `${file.name} is larger than 25 MB.`;
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Scales `width × height` so the longest side is at most `max`. */
export function thumbnailSize(width: number, height: number, max = THUMB_MAX_SIDE) {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export type Thumbnail = { blob: Blob; width: number; height: number };

/**
 * Client-made thumbnail (the contract says the client makes it): a JPEG no
 * larger than 320 px on its longest side, drawn on a canvas. Returns null
 * where the browser cannot decode the image.
 */
export async function makeThumbnail(file: Blob): Promise<Thumbnail | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined")
    return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const size = thumbnailSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  // JPEG has no alpha: paint white under transparent PNG/WebP/GIF pixels.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.8),
  );
  return blob && blob.size <= MAX_THUMB_BYTES ? { blob, ...size } : null;
}

export type PutBytes = (
  url: string,
  body: Blob,
  mime: string,
  onProgress: (fraction: number) => void,
) => Promise<void>;

/** `PUT upload_url` with the raw bytes, reporting progress (XHR has upload events). */
export const putWithProgress: PutBytes = (url, body, mime, onProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", mime);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? (onProgress(1), resolve())
        : reject(new Error("The upload failed. Try again."));
    xhr.onerror = () => reject(new Error("The upload failed. Check your connection."));
    xhr.send(body);
  });

export type UploadDeps = {
  client: Pick<MessagingClient, "claimAttachment">;
  put?: PutBytes;
  thumbnail?: (file: Blob) => Promise<Thumbnail | null>;
  digest?: (blob: Blob) => Promise<string>;
};

/**
 * Claim → PUT the file; for images also claim and PUT a `thumb` tied to the
 * file through `of_attachment_id`. A thumbnail failure never fails the send.
 */
export async function uploadAttachment(
  file: File,
  onProgress: (fraction: number) => void,
  deps: UploadDeps,
): Promise<string> {
  const put = deps.put ?? putWithProgress;
  const digest = deps.digest ?? sha256Hex;
  const mime = attachmentMime(file);
  const claim = await deps.client.claimAttachment({
    name: file.name,
    mime,
    bytes: file.size,
    sha256: await digest(file),
    role: "file",
  });
  const image = isImageMime(mime);
  await put(claim.upload_url, file, mime, (fraction) =>
    onProgress(image ? fraction * 0.9 : fraction),
  );
  if (image) {
    try {
      const thumb = await (deps.thumbnail ?? makeThumbnail)(file);
      if (thumb) {
        const thumbClaim = await deps.client.claimAttachment({
          name: `${file.name.replace(/\.[^.]+$/, "")}-thumb.jpg`,
          mime: "image/jpeg",
          bytes: thumb.blob.size,
          sha256: await digest(thumb.blob),
          role: "thumb",
          of_attachment_id: claim.attachment_id,
        });
        await put(thumbClaim.upload_url, thumb.blob, "image/jpeg", () => {});
      }
    } catch {
      // The file itself is stored; readers see the full image instead.
    }
    onProgress(1);
  }
  return claim.attachment_id;
}
