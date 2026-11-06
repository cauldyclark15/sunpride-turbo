/** Turns any picked image into JPEG bytes (the office routes only keep JPEG), via a canvas when it is not one already. */
async function asJpeg(file: File): Promise<Blob> {
  if (file.type === "image/jpeg") return file;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob | null>((done) =>
    canvas.toBlob(done, "image/jpeg", 0.85),
  );
  if (!blob) throw new Error("That picture could not be read. Take it again.");
  return blob;
}

/**
 * Uploads a count-finding photo (IP-NAV): raw JPEG to `POST /api/v1/inventory/counts/photo?sessionId=`, purpose `count-finding`,
 * owner = the count. Resolves the file id the count line takes as `photoFileId`.
 */
export async function uploadCountPhoto(
  sessionId: string,
  file: File,
): Promise<string> {
  const jpeg = await asJpeg(file);
  const response = await fetch(
    `/api/v1/inventory/counts/photo?sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: jpeg,
      credentials: "same-origin",
    },
  );
  const body = (await response.json().catch(() => null)) as {
    fileId?: string;
    error?: { message?: string };
  } | null;
  if (!response.ok || !body?.fileId)
    throw new Error(body?.error?.message ?? "The photo did not upload. Try again.");
  return body.fileId;
}

/** Opens the camera or file picker and uploads the choice. Resolves the file id, or null when the person backs out. */
export function pickCountPhoto(sessionId: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.setAttribute("capture", "environment");
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      uploadCountPhoto(sessionId, file).then(resolve, reject);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
