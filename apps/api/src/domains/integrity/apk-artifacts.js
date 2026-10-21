import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { lstat, realpath, mkdir, copyFile, readdir } from "node:fs/promises";
import { invalid } from "../../core/errors.js";
import { sha256Hex } from "../../core/util.js";

export const MAX_APK_BYTES = 120 * 1024 * 1024;
/** @param {Record<string,string|undefined>} env */
export function releaseDir(env) {
  return resolve(
    env.SP_APP_RELEASE_DIR ?? join(homedir(), ".sunpride-app-releases"),
  );
}
/** F-006: Android's existing APK signature, package and version are inspected, not administrator assertions.
 * @param {string} path @param {Record<string,string|undefined>} env */
export async function inspectApk(path, env = process.env) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size <= 0 ||
    info.size > MAX_APK_BYTES
  )
    throw invalid("Choose a signed APK below 120 MB");
  const tools =
    env.SP_ANDROID_BUILD_TOOLS ??
    join(homedir(), "Library/Android/sdk/build-tools/36.0.0");
  const jvm =
    env.SP_ANDROID_JAVA_HOME ??
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
  async function run(/** @type {string} */ tool, /** @type {string[]} */ args) {
    const p = Bun.spawn([join(tools, tool), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, JAVA_HOME: jvm },
    });
    const [out, , code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0)
      throw invalid(
        "The APK signature or Android package metadata could not be verified",
      );
    return out;
  }
  const badging = await run("aapt", ["dump", "badging", path]);
  const signature = await run("apksigner", ["verify", "--print-certs", path]);
  const m =
    /^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']*)'/m.exec(
      badging,
    );
  const certs = [
    ...signature.matchAll(
      /^Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-f]{64})$/gim,
    ),
  ];
  if (
    !m ||
    certs.length !== 1 ||
    !Number.isSafeInteger(Number(m[2])) ||
    Number(m[2]) <= 0 ||
    !m[3]
  )
    throw invalid("Publish a single-signer versioned APK");
  const packageName = m[1];
  const app = packageName.startsWith("com.sunpride.field.")
    ? "field-android"
    : packageName.startsWith("com.sunpride.van.")
      ? "van-android"
      : null;
  if (
    !app ||
    !/^com\.sunpride\.(field|van)\.(dev|beta|staging|prod)$/.test(packageName)
  )
    throw invalid("Choose a Sunpride Field or Van APK");
  return {
    app,
    packageName,
    versionCode: Number(m[2]),
    versionName: m[3],
    signerSha256: certs[0][1].toLowerCase(),
    sha256: sha256Hex(new Uint8Array(await Bun.file(path).arrayBuffer())),
    sizeBytes: info.size,
  };
}
/** @param {Record<string,string|undefined>} env @param {string} hash */
export async function artifactPath(env, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw invalid("Choose a staged APK");
  const root = await realpath(releaseDir(env)),
    path = join(root, `${hash}.apk`);
  if ((await realpath(path)) !== path || basename(path) !== `${hash}.apk`)
    throw invalid("APK must be an ordinary staged artifact");
  return path;
}
/** F-006: lead stages an existing signed artifact once; never builds or signs inside the API.
 * @param {string} source @param {Record<string,string|undefined>} env */
export async function stageApk(source, env = process.env) {
  const metadata = await inspectApk(resolve(source), env);
  const root = releaseDir(env);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, `${metadata.sha256}.apk`);
  await copyFile(resolve(source), target, 1).catch(async (e) => {
    if (e.code !== "EEXIST") throw e;
    if (
      sha256Hex(new Uint8Array(await Bun.file(target).arrayBuffer())) !==
      metadata.sha256
    )
      throw invalid("Staged artifact changed");
  });
  await Bun.write(
    join(root, `${metadata.sha256}.json`),
    JSON.stringify(metadata),
  );
  return metadata;
}
/** @param {Record<string,string|undefined>} env */
export async function stagedApks(env) {
  const root = releaseDir(env);
  const names = await readdir(root).catch(() => []);
  const manifests = names.filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
  if (manifests.length > 100)
    throw invalid(
      "Archive unused staged release descriptors before publishing more",
    );
  return Promise.all(
    manifests.map(async (n) =>
      JSON.parse(await Bun.file(join(root, n)).text()),
    ),
  );
}
