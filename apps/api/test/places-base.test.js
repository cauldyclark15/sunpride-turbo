import { describe, expect, test } from "bun:test";
import { placesBase } from "../src/domains/masters/places.js";

const GOOGLE = "https://maps.googleapis.com/maps/api";
describe("placesBase (GOOGLE_MAPS_BASE_URL)", () => {
  test("defaults to Google", () => {
    expect(placesBase({})).toBe(GOOGLE);
    expect(placesBase({ GOOGLE_MAPS_BASE_URL: "  " })).toBe(GOOGLE);
  });
  test("accepts loopback fakes", () => {
    expect(
      placesBase({ GOOGLE_MAPS_BASE_URL: "http://127.0.0.1:4723/maps/api/" }),
    ).toBe("http://127.0.0.1:4723/maps/api");
    expect(placesBase({ GOOGLE_MAPS_BASE_URL: "http://localhost:9/x" })).toBe(
      "http://localhost:9/x",
    );
  });
  test("never sends the key to a non-loopback host", () => {
    for (const v of [
      "https://evil.example/maps/api",
      "http://127.0.0.1.evil.example/",
      "file:///etc/passwd",
      "not a url",
    ])
      expect(placesBase({ GOOGLE_MAPS_BASE_URL: v })).toBe(GOOGLE);
  });
});
