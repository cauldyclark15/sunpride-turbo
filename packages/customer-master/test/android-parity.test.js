// SP-0170: the Android field app's Kotlin port of these rules is tested against
// fixtures/android-parity.json. This fails when the JS rules, labels or lists change without
// regenerating it (bun packages/customer-master/scripts/android-parity.js).
import { expect, test } from "bun:test";
import { FIXTURE, buildParity } from "../scripts/android-parity.js";

test("committed Android parity fixture matches the JS package", async () => {
  const committed = JSON.parse(await Bun.file(FIXTURE).text());
  expect(committed).toEqual(JSON.parse(JSON.stringify(await buildParity())));
  expect(committed.cases.length).toBeGreaterThan(20);
  expect(committed.fields.length).toBe(51);
});
