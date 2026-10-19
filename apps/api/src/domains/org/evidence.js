import { join } from "node:path";
import { filesDir } from "../../core/media.js";
import { ApiError } from "../../core/errors.js";
import { access } from "./readers.js";
import { uuid } from "./model.js";

/** Authenticated same-origin attachment read; never expose a filesystem path or another store's file.
 * @param {import('./model.js').Ctx} c @param {import('./model.js').Row} p
 */
export async function readEvidence(c, p) {
  await access(c, "outlets", uuid(p.outletId), "outlet.read");
  const id = uuid(p.fileId);
  const [file] =
    await c.db`select f.* from files f where f.id=${id} and f.status='stored' and (
    exists(select 1 from outlet_enrolments e where e.outlet_id=${p.outletId} and e.cis_storage_id=f.id and e.deleted_at is null)
    or exists(select 1 from outlet_enrolment_photos ep join outlet_enrolments e on e.id=ep.outlet_enrolment_id where e.outlet_id=${p.outletId} and ep.file_id=f.id and e.deleted_at is null and ep.deleted_at is null)
    or exists(select 1 from outlet_pins pin where pin.outlet_id=${p.outletId} and pin.evidence_storage_id=f.id and pin.deleted_at is null))`;
  if (
    !file ||
    !["image/jpeg", "image/png", "application/pdf"].includes(file.mime) ||
    file.path !== `${file.sha256.slice(0, 2)}/${file.sha256}`
  )
    throw new ApiError("not_found", 404, "Attachment not found");
  const blob = Bun.file(join(filesDir(c.env), file.path));
  if (!(await blob.exists()))
    throw new ApiError("not_found", 404, "Attachment not found");
  return new Response(blob, {
    headers: {
      "content-type": file.mime,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}
