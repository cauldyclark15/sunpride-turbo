import { test, expect } from "bun:test";
import { startHarness } from "./harness.js";
import { fieldDownloadUrl } from "../src/domains/integrity/field-updates.js";
import { install } from "../src/domains/integrity/index.js";

const token = "sample-publisher-credential-for-SP0245-only";
/** @param {number} version @param {Record<string,any>} [extra] */
const build = (version, extra = {}) => ({
  app: "field",
  version_code: version,
  version_name: `1.0.0-beta.${version}`,
  download_url: `https://drive.google.com/file/d/SAMPLE_${version}/view?usp=drivesdk`,
  notes: "SAMPLE update",
  git_sha: "a".repeat(40),
  ...extra,
});

test("publisher hook, version discovery, optional/required policy, replay and isolated packages", async () => {
  const h = await startHarness({
    installers: [install],
    env: { SP_APP_RELEASE_TOKEN: token + "\n" },
  });
  try {
    /** @param {any} body @param {string} [credential] */
    const publish = (body, credential = token) =>
      h.fetch("/api/v1/apps/releases", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(body),
      });
    const latest = (pkg = "com.sunpride.field.beta") =>
      h.fetch(`/api/v1/apps/latest?app=field&packageName=${pkg}`);
    expect(await (await latest()).json()).toEqual({ release: null });
    expect(
      (await publish(build(10), "sample-wrong-publisher-credential")).status,
    ).toBe(403);
    expect(
      (
        await h.fetch("/api/v1/apps/releases", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(build(10)),
        })
      ).status,
    ).toBe(403);
    for (const b of [
      build(10, { app: "van" }),
      build(10, { version_code: 0 }),
      build(10, { minimum_supported_version_code: 11 }),
      build(10, { minimum_supported_version_code: -1 }),
      build(10, { git_sha: "bad" }),
      build(10, { package_name: "com.other.field.beta" }),
    ])
      expect((await publish(b)).status).toBe(400);
    // This is the unchanged automation's exact body shape: no package/minimum fields required.
    const first = await publish(build(10));
    expect(first.status).toBe(200);
    const saved = await first.json();
    expect(saved.notified).toBe(0); // In-app discovery, not a claim of push notifications.
    expect(saved.minimum_supported_version_code).toBe(0);
    const read = await latest();
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toMatchObject({
      version_code: 10,
      version_name: "1.0.0-beta.10",
      download_url: build(10).download_url,
    });
    expect(
      await (await h.fetch("/api/v1/apps/latest?app=field")).json(),
    ).toMatchObject({ version_code: 10 });
    expect(await (await latest("com.sunpride.field.dev")).json()).toEqual({
      release: null,
    });
    expect((await publish(build(10))).status).toBe(200);
    expect(
      (await publish(build(10, { download_url: build(11).download_url })))
        .status,
    ).toBe(409);
    expect(
      (await publish(build(11, { minimum_supported_version_code: 8 }))).status,
    ).toBe(200);
    expect(await (await latest()).json()).toMatchObject({
      version_code: 11,
      minimum_supported_version_code: 8,
    });
    expect((await publish(build(12))).status).toBe(200);
    expect(await (await latest()).json()).toMatchObject({
      version_code: 12,
      minimum_supported_version_code: 8,
    });
    // A late publisher retry cannot demote the newest available version or change its policy.
    expect((await publish(build(10))).status).toBe(200);
    expect((await publish(build(9))).status).toBe(200);
    expect(await (await latest()).json()).toMatchObject({
      version_code: 12,
      minimum_supported_version_code: 8,
    });
    expect(
      (await publish(build(13, { minimum_supported_version_code: 0 }))).status,
    ).toBe(200);
    expect(await (await latest()).json()).toMatchObject({
      version_code: 13,
      minimum_supported_version_code: 0,
    });
    expect((await latest("com.sunpride.van.beta")).status).toBe(400);
    expect((await h.fetch("/api/v1/apps/latest?app=van")).status).toBe(400);
    expect(
      (await publish(build(20, { package_name: "com.sunpride.field.dev" })))
        .status,
    ).toBe(200);
    expect(await (await latest()).json()).toMatchObject({ version_code: 13 });
    expect(await (await latest("com.sunpride.field.dev")).json()).toMatchObject(
      { version_code: 20 },
    );
    expect(
      Number((await h.db`select count(*) as n from field_app_updates`)[0].n),
    ).toBe(6);
    h.env.SP_APP_RELEASE_TOKEN = undefined;
    expect((await publish(build(30))).status).toBe(403);
  } finally {
    await h.close();
  }
}, 60000);

test("download targets refuse unsafe or unrelated links", () => {
  for (const url of [
    "http://drive.google.com/file/d/SAMPLE/view",
    "https://evil.example/app.apk",
    "file:///app.apk",
    "javascript:alert(1)",
    "https://drive.google.com.evil.example/file/d/SAMPLE/view",
    "https://u:p@drive.google.com/file/d/SAMPLE/view",
    "https://drive.google.com/file/d/SAMPLE/view?redirect=bad",
    "https://drive.google.com/file/d/SAMPLE/view?usp=drivesdk&redirect=bad",
    "https://drive.google.com/file/d/SAMPLE/view?usp=drivesdk&usp=sharing",
    "https://drive.google.com/file/d/SAMPLE/view?usp=unknown",
    "https://sunpride.cauldnclark.com/downloads/field-10.apk?usp=drivesdk",
    "https://sunpride.cauldnclark.com/api/v1/private.apk",
  ])
    expect(() => fieldDownloadUrl(url)).toThrow();
  for (const suffix of ["", "?usp=drivesdk", "?usp=sharing"]) {
    const url = `https://drive.google.com/file/d/SAMPLE/view${suffix}`;
    expect(fieldDownloadUrl(url)).toBe(url);
  }
  expect(
    fieldDownloadUrl("https://sunpride.cauldnclark.com/downloads/field-10.apk"),
  ).toContain("/downloads/");
});
