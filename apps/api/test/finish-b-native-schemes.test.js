import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildNativeSchemes } from "../scripts/build-native-schemes.js";
import { evaluateSchemes } from "../src/domains/tpm/engine.js";
import { safeEqual, sha256Hex } from "../src/core/util.js";

test("F-502 F-503 native compatibility bundle preserves canonical mechanics and eligibility without server facilities", async () => {
  const dir = await mkdtemp(
    join(
      process.env.TMPDIR ?? "/Users/jc/.hermes/cache/scratch",
      "sp-schemes-",
    ),
  );
  try {
    const manifest = await buildNativeSchemes(dir),
      script = await Bun.file(join(dir, "sunpride-schemes.js")).text();
    expect(sha256Hex(script)).toBe(manifest.sha256);
    expect(script).not.toMatch(/Bun\.|TextEncoder|Buffer\./);
    const quote = new Function(
      script + ";return globalThis.sunprideSchemeQuote;",
    )();
    const fixtures = await Bun.file(
      new URL(
        "../../../packages/native-promotions/fixtures/scheme-v1-parity.json",
        import.meta.url,
      ),
    ).json();
    for (const row of fixtures) {
      expect(
        evaluateSchemes(
          row.request.lines,
          row.request.promotions,
          row.request.facts,
        ),
      ).toEqual(row.expected);
      expect(JSON.parse(quote(JSON.stringify(row.request)))).toEqual({
        ok: true,
        result: row.expected,
      });
    }
    expect(JSON.parse(quote(JSON.stringify({ engineVersion: 99 })))).toEqual({
      ok: false,
      error: { code: "scheme_unavailable" },
    });
    expect(safeEqual("mañana", "mañana")).toBe(true);
    expect(safeEqual("mañana", "manana")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
