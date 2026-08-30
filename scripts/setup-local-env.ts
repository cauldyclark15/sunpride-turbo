import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");

const environmentFiles = [
  ["packages/backend/.env.example", "packages/backend/.env.local"],
  ["apps/web/.env.example", "apps/web/.env.local"],
  ["apps/pwa/.env.example", "apps/pwa/.env.local"],
  ["apps/sap-connector/.env.example", "apps/sap-connector/.env.local"],
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

const connectorPath = resolve(repositoryRoot, "apps/sap-connector/.env.local");
const connectorContents = readFileSync(connectorPath, "utf8");
const configuredSecret = connectorContents.match(
  /^CONNECTOR_SIGNING_SECRET=(.+)$/m,
)?.[1];

if (configuredSecret) {
  console.log("Kept existing SAP connector signing secret");
  process.exit(0);
}

const result = Bun.spawnSync(
  ["bunx", "convex", "env", "get", "CONNECTOR_SIGNING_SECRET"],
  {
    cwd: resolve(repositoryRoot, "packages/backend"),
    stdout: "pipe",
    stderr: "pipe",
  },
);
const signingSecret = new TextDecoder().decode(result.stdout).trim();

if (result.exitCode !== 0 || !signingSecret) {
  console.warn(
    "Could not retrieve CONNECTOR_SIGNING_SECRET. Authenticate with Convex, then rerun `bun run setup:env`.",
  );
  process.exitCode = 1;
} else {
  const updatedContents = connectorContents.replace(
    /^CONNECTOR_SIGNING_SECRET=.*$/m,
    `CONNECTOR_SIGNING_SECRET=${signingSecret}`,
  );
  writeFileSync(connectorPath, updatedContents, { mode: 0o600 });
  chmodSync(connectorPath, 0o600);
  console.log(
    "Retrieved the SAP connector signing secret from Convex without printing it",
  );
}
