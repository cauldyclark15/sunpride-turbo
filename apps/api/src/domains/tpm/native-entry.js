import { evaluateSchemes, ENGINE_VERSION } from "./engine.js";
/** F-502/F-503: the Android interpreter executes this SAME authority, not a translated promotion algorithm. */
/** @type {any} */ (globalThis).sunprideSchemeQuote = (
  /** @type {string} */ request,
) => {
  try {
    const q = JSON.parse(request);
    if (q.engineVersion !== ENGINE_VERSION)
      throw new Error("Unsupported scheme version");
    return JSON.stringify({
      ok: true,
      result: evaluateSchemes(q.lines, q.promotions, q.facts ?? {}),
    });
  } catch (error) {
    const e = /** @type {any} */ (error);
    return JSON.stringify({
      ok: false,
      error: {
        code: typeof e.code === "string" ? e.code : "scheme_unavailable",
      },
    });
  }
};
