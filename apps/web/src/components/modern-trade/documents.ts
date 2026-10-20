import { apiFetch } from "../../lib/api";
/** F-306 F-307: one byte-preserving browser boundary for source originals. */
export async function filePayload(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return { filename: file.name, contentBase64: btoa(binary) };
}
export async function downloadDocument(endpoint: string, id: string) {
  const doc = await apiFetch<{ filename: string; content_base64: string }>(
    endpoint,
    { query: { id } },
  );
  const bytes = Uint8Array.from(atob(doc.content_base64), (c) =>
    c.charCodeAt(0),
  );
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/octet-stream" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.filename;
  a.click();
  URL.revokeObjectURL(url);
}
