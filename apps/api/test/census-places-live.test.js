import { expect, test } from "bun:test";
import {
  autocomplete,
  details,
  reverse,
} from "../src/domains/masters/places.js";

/** Opt-in live smoke against Google (never in the normal suite): CG_LIVE_GOOGLE=1. */
const live = process.env.CG_LIVE_GOOGLE === "1";
const key = live
  ? (
      await Bun.file(
        `${process.env.HOME}/.sunpride-keys/google-maps-key`,
      ).text()
    ).trim()
  : "";
/** @param {string} query */
const ctx = (query) => ({
  actor: { role: "manager", subject: "live-smoke", userId: "live-smoke" },
  env: { GOOGLE_MAPS_SERVER_KEY: key },
  url: new URL(`http://x/?${query}`),
  db: async () => [{ count: 1, reset_ms: 0 }],
});

test.skipIf(!live)(
  "SP-0162 live Google: autocomplete → details → reverse",
  async () => {
    const session = crypto.randomUUID();
    const a = await autocomplete(
      ctx(`input=SM%20Seaside%20Cebu&session=${session}`),
    );
    expect(a.predictions.length).toBeGreaterThan(0);
    const d = await details(
      ctx(
        `placeId=${encodeURIComponent(a.predictions[0].placeId)}&session=${session}`,
      ),
    );
    expect(Number.isFinite(d.latitude)).toBe(true);
    expect(d.components.city ?? d.components.province).toBeTruthy();
    const r = await reverse(ctx(`lat=${d.latitude}&lng=${d.longitude}`));
    expect(r.formattedAddress.length).toBeGreaterThan(0);
    console.log(
      "live smoke ok:",
      a.predictions.length,
      "suggestions; city:",
      d.components.city,
    );
  },
);
