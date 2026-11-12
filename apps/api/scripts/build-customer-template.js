// SP-0170: write the client-ready customer upload template (.xlsx) from a database's reference
// lists — the same code the web app's "Download template (Excel)" runs.
// Usage: DATABASE_URL=... bun apps/api/scripts/build-customer-template.js <out.xlsx>
import { createDb } from "@sunpride/db/client";
import { customerTemplateXlsx } from "@sunpride/import-templates/customers-xlsx";
import { templateReference } from "../src/domains/imports/customer-upload.js";

const url = process.env.DATABASE_URL;
const out = process.argv[2];
if (!url) throw new Error("Set DATABASE_URL");
if (!out) throw new Error("Usage: build-customer-template.js <out.xlsx>");
const db = createDb(url, { max: 1 });
try {
  const reference = await templateReference(db);
  const bytes = await customerTemplateXlsx(reference);
  await Bun.write(out, bytes);
  console.log(
    JSON.stringify({ out, bytes: bytes.length, referenceRows: reference.length }),
  );
} finally {
  await db.close();
}
