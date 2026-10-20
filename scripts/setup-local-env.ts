import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");

const environmentFiles = [
  ["apps/web/.env.example", "apps/web/.env.local"],
  ["apps/pwa/.env.example", "apps/pwa/.env.local"],
] as const;

for (const [examplePath, localPath] of environmentFiles) {
  const source = resolve(repositoryRoot, examplePath);
  const destination = resolve(repositoryRoot, localPath);

  if (existsSync(destination) && !force) {
    console.log(`Kept existing ${localPath}`);
    continue;
  }

  writeFileSync(destination, readFileSync(source, "utf8"), { mode: 0o600 });
  chmodSync(destination, 0o600);
  console.log(`Created ${localPath}`);
}
