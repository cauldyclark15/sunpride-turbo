import { join } from "node:path";
import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { uuid, rule, required, integer } from "../org/model.js";
import { writeAudit } from "../org/audit.js";
import { filesDir } from "../../core/media.js";

/** F-616 editable, prospective beta content. SAP replicas stay read-only.
 * @param {any} ctx @param {any} p */
export async function saveCatalogue(ctx, p) {
  const actor = await requireCapability(ctx, "masterdata.manage");
  await requireNationalScope(ctx, ["admin", "operations"]);
  const productId = uuid(p.productId),
    [product] =
      await ctx.db`select id from products where id=${productId} and deleted_at is null`;
  if (!product) rule("Choose an existing product.");
  const [prior] =
    await ctx.db`select * from product_catalogue_versions where product_id=${productId} order by revision desc limit 1`;
  if ((prior?.revision ?? 0) !== p.baseRevision)
    rule("Catalogue content changed. Reload it before saving.");
  if (prior?.source === "sap")
    rule(
      "SAP owns this content. Correct the source replica instead of overwriting it.",
    );
  if (prior && new Date(prior.effective_from).getTime() > ctx.now)
    rule("A future revision is already scheduled. Wait for it to take effect.");
  const at = integer(
      p.effectiveFrom ?? ctx.now,
      ctx.now,
      ctx.now + 366 * 86400000,
    ),
    revision = (prior?.revision ?? 0) + 1;
  if (prior && at <= new Date(prior.effective_from).getTime())
    rule("Choose a later effective instant.");
  const description = required(p.description, "Description", 2000),
    ingredients = required(p.ingredients, "Ingredients", 2000),
    allergens = required(p.allergens, "Allergens", 2000),
    storage = required(p.storage, "Storage", 2000),
    caseSpecifications = required(
      p.caseSpecifications,
      "Case specifications",
      2000,
    ),
    shelfLifeDays = integer(p.shelfLifeDays, 0, 3650),
    reason = required(p.reason, "Change reason", 500);
  const bytes = new Uint8Array(await Bun.file(SAMPLE_IMAGE).arrayBuffer());
  let sha256 =
      prior?.image_sha256 ??
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    imageBytes = prior?.image_bytes ?? bytes.length,
    imageFileId = prior?.image_file_id ?? null;
  if (p.imageFileId) {
    const [file] =
      await ctx.db`select * from files where id=${uuid(p.imageFileId)} and owner_id=${productId} and purpose='catalogue-product' and created_by=${actor.userId} and status='stored' and mime='image/jpeg'`;
    if (!file || Number(file.size) > 512 * 1024)
      rule("Upload a catalogue image for this product under your own account.");
    imageFileId = file.id;
    sha256 = file.sha256;
    imageBytes = Number(file.size);
  }
  if (prior)
    await ctx.db`update product_catalogue_versions set effective_to=${new Date(at)} where id=${prior.id}`;
  const [row] =
    await ctx.db`insert into product_catalogue_versions(product_id,revision,source,source_reference,description,ingredients,allergens,storage,shelf_life_days,case_specifications,image_sha256,image_bytes,image_file_id,effective_from) values(${productId},${revision},'sample','WEB-EDITABLE-BETA',${description},${ingredients},${allergens},${storage},${shelfLifeDays},${caseSpecifications},${sha256},${imageBytes},${imageFileId},${new Date(at)}) returning id`;
  await writeAudit(ctx.db, {
    actor,
    action: "masters.catalogue.revise",
    entityType: "product",
    entityId: productId,
    details: { revision, reason, source: "sample" },
    at: ctx.now,
  });
  return { id: row.id, productId, revision };
}
/** @param {any} ctx */
export async function catalogueSetup(ctx) {
  await requireCapability(ctx, "masterdata.manage");
  await requireNationalScope(ctx, ["admin", "operations"]);
  const products =
    await ctx.db`select id,code,name from products where deleted_at is null order by code limit 1001`;
  if (products.length > 1000)
    rule("Catalogue setup exceeds 1000 products.", "overflow");
  const rows = [];
  for (const p of products)
    rows.push({
      ...p,
      catalogue: await catalogueMetadata(ctx.db, p.id, ctx.now),
    });
  return { rows };
}
export const SAMPLE_IMAGE = join(
  import.meta.dir,
  "../../../assets/sample-catalogue.jpg",
);
/** F-616 content DTO for a product whose selling/catalogue scope the caller already
 * authorized. Pack quantities derive from governed UOMs, never sample case counts.
 * SEAM(SAP): append versioned content from material replication, not price authority.
 * @param {any} db @param {string} productId @param {number} at */
export async function catalogueMetadata(db, productId, at) {
  const [content] =
    await db`select * from product_catalogue_versions where product_id=${productId} and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)})`;
  if (!content) return null;
  const [p] =
    await db`select p.*,u.code base_code from products p join units_of_measure u on u.id=p.base_uom_id where p.id=${productId} and p.deleted_at is null and p.active`;
  if (!p) return null;
  const packs =
    await db`select u.code,u.name,u.id from product_selling_uoms s join units_of_measure u on u.id=s.uom_id where s.product_id=${productId} and s.deleted_at is null and u.active and u.deleted_at is null order by s.ordinal limit 101`;
  if (packs.length > 100)
    rule("Catalogue pack hierarchy exceeds 100 levels.", "overflow");
  const packHierarchy = [];
  for (const u of packs) {
    if (u.id === p.base_uom_id) {
      packHierarchy.push({
        uom: u.code,
        label: u.name,
        numerator: 1,
        denominator: 1,
        baseUom: p.base_code,
      });
      continue;
    }
    const conversions =
      await db`select * from uom_conversions where (product_id=${productId} or product_id is null) and from_uom_id=${u.id} and to_uom_id=${p.base_uom_id} and active and deleted_at is null and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) order by product_id nulls last limit 3`;
    const specific = conversions.filter(
        (/** @type {any} */ c) => c.product_id === productId,
      ),
      possible = specific.length ? specific : conversions;
    if (possible.length !== 1) {
      packHierarchy.push({
        uom: u.code,
        label: u.name,
        numerator: null,
        denominator: null,
        baseUom: p.base_code,
      });
      continue;
    }
    const c = possible[0],
      n = Number(c.numerator),
      d = Number(c.denominator) * Number(p.quantity_scale);
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d))
      rule("Pack conversion exceeds the supported exact range.");
    packHierarchy.push({
      uom: u.code,
      label: u.name,
      numerator: n,
      denominator: d,
      baseUom: p.base_code,
    });
  }
  return {
    revision: content.revision,
    versionId: content.id,
    source: content.source,
    sample: content.source === "sample",
    description: content.description,
    ingredients: content.ingredients,
    allergens: content.allergens,
    storage: content.storage,
    shelfLifeDays: content.shelf_life_days,
    caseSpecifications: content.case_specifications,
    packHierarchy,
    image: content.image_sha256
      ? {
          path: `/api/v1/masters/catalogue-images/${content.id}`,
          sha256: content.image_sha256,
          bytes: content.image_bytes,
        }
      : null,
  };
}
/** The sample illustration is explicitly public training material, not an outlet
 * evidence file. Require an active signed-in profile, but never serve arbitrary paths.
 * @param {any} ctx */
export async function catalogueImage(ctx) {
  await requireCapability(ctx, "outlet.read");
  const [row] =
    await ctx.db`select c.* from product_catalogue_versions c join products p on p.id=c.product_id where c.id=${uuid(ctx.params.id)} and p.active and p.deleted_at is null`;
  if (!row?.image_sha256)
    throw new ApiError("not_found", 404, "Catalogue image is not available.");
  let path = SAMPLE_IMAGE;
  if (row.image_file_id) {
    const [file] =
      await ctx.db`select * from files where id=${row.image_file_id} and owner_id=${row.product_id} and purpose='catalogue-product' and status='stored' and mime='image/jpeg'`;
    if (
      !file ||
      file.sha256 !== row.image_sha256 ||
      Number(file.size) !== row.image_bytes ||
      file.path !== `${file.sha256.slice(0, 2)}/${file.sha256}`
    )
      throw new ApiError("not_found", 404, "Catalogue image is not available.");
    path = join(filesDir(ctx.env), file.path);
  } else if (row.source !== "sample")
    throw new ApiError("not_found", 404, "Catalogue image is not available.");
  const image = Bun.file(path);
  if (!(await image.exists()))
    throw new ApiError("not_found", 404, "Catalogue image is not available.");
  return new Response(image, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=86400",
      etag: row.image_sha256,
      "x-content-type-options": "nosniff",
    },
  });
}
