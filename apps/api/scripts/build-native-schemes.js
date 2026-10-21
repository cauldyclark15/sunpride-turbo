import ts from "typescript";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { ENGINE_VERSION } from "../src/domains/tpm/engine.js";
import { sha256Hex } from "../src/core/util.js";
/** F-502/F-503 reproducible compatibility bundle. Lower syntax only; retain canonical BigInt money.
 * @param {string} directory */
export async function buildNativeSchemes(directory) {
  const built = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../src/domains/tpm/native-entry.js"),
    ],
    target: "browser",
    format: "iife",
    minify: false,
  });
  if (!built.success) throw new Error("Could not bundle canonical schemes");
  const text = ts.transpileModule(await built.outputs[0].text(), {
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.None,
      downlevelIteration: true,
    },
  }).outputText;
  if (/Bun\.|TextEncoder|Buffer\./.test(text))
    throw new Error("Native schemes must not depend on server facilities");
  const digest = sha256Hex(text),
    manifest = {
      engineVersion: ENGINE_VERSION,
      bridgeVersion: 1,
      sha256: digest,
    };
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, "sunpride-schemes.js"), text);
  await Bun.write(
    join(directory, "sunpride-schemes.json"),
    JSON.stringify(manifest),
  );
  return manifest;
}
if (import.meta.main) {
  if (!process.argv[2])
    throw new Error("Pass the generated Java-resources directory");
  await buildNativeSchemes(resolve(process.argv[2]));
  console.log("Canonical offline schemes bundled");
}
