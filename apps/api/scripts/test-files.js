import { Glob } from "bun";
import { resolve } from "node:path";
import { testFileConcurrency } from "./test-file-concurrency.js";

// Bun module mocks are process-global. A file is the isolation boundary, while
// each file's harness retains its own SP_LANE-derived disposable database.
const root = resolve(import.meta.dir, "..");
const filters = process.argv.slice(2);
const files = Array.from(new Glob("**/*.test.js").scanSync({ cwd: root }))
  .filter((file) => !file.startsWith("node_modules/"))
  .filter((file) => !filters.length || filters.some((f) => file.includes(f)))
  .sort();
if (!files.length) throw new Error("No matching test files");
let pass = 0;
let fail = 0;
let skip = 0;
let failedFiles = 0;
async function run(file) {
  const proc = Bun.spawn([process.execPath, "test", `./${file}`], {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = stdout + stderr;
  console.log(`\n=== ${file} (EXIT=${exit}) ===\n${output}`);
  const count = (kind) =>
    Number(output.match(new RegExp(`^\\s*(\\d+) ${kind}\\s*$`, "m"))?.[1] ?? 0);
  pass += count("pass");
  fail += count("fail");
  skip += count("skip");
  if (exit !== 0) failedFiles++;
}
const regular = files.filter((file) => !file.includes("performance.test.js"));
let next = 0;
const concurrency = testFileConcurrency(process.env.SP_TEST_CONCURRENCY);
console.log(`Test-file concurrency: ${concurrency}`);
await Promise.all(
  Array.from({ length: Math.min(concurrency, regular.length) }, async () => {
    while (next < regular.length) await run(regular[next++]);
  }),
);
// Performance assertions must not measure three concurrent test migrations.
for (const file of files.filter((file) => file.includes("performance.test.js")))
  await run(file);
console.log(
  `ISOLATED TOTAL: ${pass} pass, ${fail} fail, ${skip} skip; ${files.length} files, ${failedFiles} failed files`,
);
process.exitCode = failedFiles ? 1 : 0;
