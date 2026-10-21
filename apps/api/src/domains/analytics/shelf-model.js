import { fail } from "../orders/validation.js";

/** Local model protocol: JSON on stdin with original image bytes, pinned artifact version and expected planogram.
 * No model command comes from an HTTP request. No shell or raw stderr is exposed.
 * @param {Uint8Array} bytes @param {any} configuration @param {Record<string,string|undefined>} [env] */
export async function inferShelf(bytes, configuration, env = process.env) {
  if (!env.SUNPRIDE_SHELF_MODEL_COMMAND)
    return {
      available: false,
      reason: "No shelf model is configured; complete manual review",
      detections: [],
    };
  /** @type {any} */ let child;
  try {
    const command = JSON.parse(env.SUNPRIDE_SHELF_MODEL_COMMAND);
    if (
      !Array.isArray(command) ||
      !command.length ||
      command.some((v) => typeof v !== "string" || !v)
    )
      throw new Error("configuration");
    if (bytes.length > 10 * 1024 * 1024 || !bytes.length)
      throw new Error("image");
    child = Bun.spawn(command, {
      stdin: Buffer.from(
        JSON.stringify({
          imageBase64: Buffer.from(bytes).toString("base64"),
          modelVersion: configuration.adapterVersion,
        }),
      ),
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill(), 20000);
    try {
      const reader = child.stdout.getReader(),
        chunks = [];
      let length = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 256000) {
          child.kill();
          throw new Error("output_limit");
        }
        chunks.push(part.value);
      }
      if ((await child.exited) !== 0) throw new Error("adapter");
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (result.modelVersion !== configuration.adapterVersion)
        throw new Error("wrong_model");
      return {
        available: true,
        ...shelfFacts(result.detections, configuration),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    child?.kill();
    return {
      available: false,
      reason: "Shelf inference is unavailable; complete manual review",
      detections: [],
    };
  }
}
/** Detections are review suggestions, never canonical shelf measurements until a human captures them.
 * @param {any} detections @param {any} configuration */
export function shelfFacts(detections, configuration) {
  if (!Array.isArray(detections) || detections.length > 500)
    fail("Invalid shelf detections");
  const threshold = configuration.minimumConfidence ?? 0.8;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    fail("Invalid model confidence threshold");
  const expected = configuration.expectedFacings ?? {};
  const accepted = detections.map((/** @type {any} */ d) => {
    if (
      typeof d.productCode !== "string" ||
      !d.productCode ||
      d.productCode.length > 80 ||
      !Number.isFinite(d.confidence) ||
      d.confidence < 0 ||
      d.confidence > 1 ||
      !Array.isArray(d.box) ||
      d.box.length !== 4 ||
      d.box.some(
        (/** @type {any} */ n) => !Number.isFinite(n) || n < 0 || n > 1,
      ) ||
      d.box[2] <= d.box[0] ||
      d.box[3] <= d.box[1]
    )
      fail("Invalid shelf detection");
    return { productCode: d.productCode, confidence: d.confidence, box: d.box };
  });
  const counts = new Map();
  for (const d of accepted.filter(
    (/** @type {any} */ d) => d.confidence >= threshold,
  ))
    counts.set(d.productCode, (counts.get(d.productCode) ?? 0) + 1);
  const all = Array.from(counts.values()).reduce((n, v) => n + v, 0);
  const rows = Array.from(
    new Set([...Object.keys(expected), ...counts.keys()]),
  ).map((productCode) => {
    const facingCount = counts.get(productCode) ?? 0,
      target = expected[productCode] ?? null;
    if (
      target !== null &&
      (!Number.isSafeInteger(target) || target < 0 || target > 500)
    )
      fail("Invalid expected facings");
    return {
      productCode,
      facingCount,
      expectedFacings: target,
      compliant: target === null ? null : facingCount >= target,
      shareOfShelfPct: all ? Math.round((facingCount * 1000) / all) / 10 : null,
    };
  });
  const slots = configuration.expectedSlots ?? [];
  if (!Array.isArray(slots) || slots.length > 500)
    fail("Invalid expected planogram slots");
  const used = new Set();
  const placements = slots.map((/** @type {any} */ slot) => {
    if (
      typeof slot.productCode !== "string" ||
      !Array.isArray(slot.box) ||
      slot.box.length !== 4 ||
      slot.box.some(
        (/** @type {any} */ n) => !Number.isFinite(n) || n < 0 || n > 1,
      ) ||
      slot.box[0] >= slot.box[2] ||
      slot.box[1] >= slot.box[3]
    )
      fail("Invalid expected planogram slot");
    const index = accepted.findIndex(
      (/** @type {any} */ d, /** @type {number} */ i) =>
        !used.has(i) &&
        d.confidence >= threshold &&
        d.productCode === slot.productCode &&
        (d.box[0] + d.box[2]) / 2 >= slot.box[0] &&
        (d.box[0] + d.box[2]) / 2 <= slot.box[2] &&
        (d.box[1] + d.box[3]) / 2 >= slot.box[1] &&
        (d.box[1] + d.box[3]) / 2 <= slot.box[3],
    );
    if (index >= 0) used.add(index);
    return {
      productCode: slot.productCode,
      matched: index >= 0,
      box: slot.box,
    };
  });
  return {
    placements,
    planogramCompliancePct: slots.length
      ? Math.round(
          (placements.filter((/** @type {any} */ p) => p.matched).length *
            1000) /
            slots.length,
        ) / 10
      : null,
    detections: accepted,
    rows,
    uncertainCount: accepted.filter(
      (/** @type {any} */ d) => d.confidence < threshold,
    ).length,
    measurement:
      "visible facing-count share; configured slot matching; review all predictions",
    requiresReview: true,
  };
}
