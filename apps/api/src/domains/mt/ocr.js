import { fileURLToPath } from "node:url";
import { ApiError } from "../../core/errors.js";

/** F-306 local Apple Vision by default; a Linux deployment can configure a JSON argv adapter.
 * Adapter receives original bytes on stdin and returns {modelVersion,text,observations}; no shell.
 * @param {Uint8Array} bytes @param {Record<string,string|undefined>} [env] */
export async function extractDocumentText(bytes, env = process.env) {
  const configured = env.SUNPRIDE_OCR_COMMAND;
  const cmd = configured
    ? JSON.parse(configured)
    : process.platform === "darwin"
      ? [
          "/usr/bin/swift",
          fileURLToPath(new URL("../../../scripts/ocr.swift", import.meta.url)),
        ]
      : null;
  if (
    !Array.isArray(cmd) ||
    !cmd.length ||
    cmd.some((v) => typeof v !== "string" || !v)
  )
    throw new ApiError(
      "ocr_unavailable",
      422,
      "Local OCR is unavailable. Configure SUNPRIDE_OCR_COMMAND or enter the source facts for review.",
    );
  const child = Bun.spawn(cmd, {
    stdin: bytes,
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [text, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    if (code !== 0 || text.length > 128_000) throw new Error("ocr_failed");
    const result = JSON.parse(text);
    if (
      typeof result.modelVersion !== "string" ||
      typeof result.text !== "string" ||
      result.text.length > 80_000 ||
      !Array.isArray(result.observations) ||
      result.observations.length > 2000
    )
      throw new Error("ocr_failed");
    return result;
  } catch {
    throw new ApiError(
      "ocr_unavailable",
      422,
      "The scan could not be read. Upload a clearer image/PDF or edit its source facts for review.",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Recognition is assistive only; ambiguous dates, descriptions and currencies remain review exceptions.
 * @param {any} extraction */
export function purchaseOrderFromText(extraction) {
  const text = extraction.text;
  const poNumber =
    /\bPO[-\s]*(?:NUMBER|NO\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9._/-]*)/i.exec(
      text,
    )?.[1] ?? "";
  const serviceDate =
    /(?:DELIVERY[-\s]*DATE|REQUESTED[-\s]*DATE)\s*:?\s*(\d{4}-\d{2}-\d{2})/i.exec(
      text,
    )?.[1] ?? "";
  const lines = [];
  for (const row of text.split(/\r?\n/)) {
    const match =
      /^\s*(?:\d+[.)]\s+)?([A-Z0-9][A-Z0-9._/-]{1,50})\s+(?:.*?\s+)?(PC|PCS|EA|CS|CASE|BOX|PACK|KG|G|BTL|BAG)\s+(\d+(?:\.\d{1,3})?)(?:\s+(?:PHP|₱)?\s*(\d+(?:,\d{3})*(?:\.\d{2})?))?\s*$/i.exec(
        row,
      );
    if (!match) continue;
    const money = match[4]?.replaceAll(",", "");
    lines.push({
      productCode: match[1],
      uom: match[2].toUpperCase(),
      quantity: Number(match[3]),
      requestedPriceCentavos: money
        ? Number(
            BigInt(money.split(".")[0]) * 100n +
              BigInt(money.split(".")[1] ?? 0),
          )
        : null,
    });
  }
  return {
    poNumber,
    serviceDate,
    lines: lines.slice(0, 100),
    extraction,
    exceptions: [
      "OCR-assisted draft: review the source scan and confirm every extracted field.",
      ...(lines.length > 100
        ? ["The scan has more than 100 lines; split the purchase order."]
        : []),
    ],
  };
}
export const localOcr = {
  extract: async (/** @type {Uint8Array} */ bytes) =>
    purchaseOrderFromText(await extractDocumentText(bytes)),
};
