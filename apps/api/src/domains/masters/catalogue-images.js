import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { filesDir } from "../../core/media.js";
import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { uuid, required, rule } from "../org/model.js";
import { validateCatalogueJpeg } from "./photo.js";

/** F-616 reuse core content-addressed files, bind uploader + product, then freeze
 * the chosen image into a new content revision. A failed form never changes the
 * previous published catalogue and a product image is never outlet evidence.
 * @param {any} ctx @param {any} p */
export async function uploadCatalogueImage(ctx, p) {
  const actor = await requireCapability(ctx, "masterdata.manage");
  await requireNationalScope(ctx, ["admin", "operations"]);
  const id = uuid(p.productId),
    [product] =
      await ctx.db`select id from products where id=${id} and deleted_at is null`;
  if (!product) rule("Choose an existing product.");
  const [prior] =
    await ctx.db`select source from product_catalogue_versions where product_id=${id} order by revision desc limit 1`;
  if (prior?.source === "sap")
    rule("SAP owns this image. Correct its source replica instead.");
  const encoded = required(p.jpegBase64, "Catalogue JPEG", 700000),
    bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) rule("Choose a valid JPEG image.");
  validateCatalogueJpeg(bytes);
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    relative = `${sha.slice(0, 2)}/${sha}`,
    folder = join(filesDir(ctx.env), sha.slice(0, 2));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temp = join(folder, `${sha}.${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(temp, bytes);
    await rename(temp, join(filesDir(ctx.env), relative));
  } finally {
    await rm(temp, { force: true });
  }
  const [file] =
    await ctx.db`insert into files(owner_id,purpose,sha256,mime,size,path,status,created_by) values(${id},'catalogue-product',${sha},'image/jpeg',${bytes.length},${relative},'stored',${actor.userId}) on conflict(created_by,purpose,owner_id,sha256) do update set status='stored' returning id`;
  return { id: file.id, productId: id, sha256: sha, bytes: bytes.length };
}
