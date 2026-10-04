#!/usr/bin/env bun
/**
 * Secret and client-configuration audit (QSR-008).
 *
 *   bun scripts/secret-audit.ts            # repository + built client bundles
 *   bun scripts/secret-audit.ts --repo     # tracked files and configuration only
 *   bun scripts/secret-audit.ts --bundles  # built web/PWA (and Android BuildConfig) only
 *
 * Findings name the file, the rule and (for configuration names) the variable.
 * A secret VALUE is never printed. Policy: docs/security/SECRETS_AND_CLIENT_CONFIG.md
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Finding = { file: string; rule: string; detail?: string };

/** Configuration names whose values are secrets. Server, Convex or connector only. */
export const SECRET_NAMES = [
  "BETTER_AUTH_SECRET",
  "AUTH_SECRET",
  "CONNECTOR_SIGNING_SECRET",
  "MOBILE_CURSOR_SECRET",
  "SAP_USERNAME",
  "SAP_PASSWORD",
  "CONVEX_DEPLOY_KEY",
] as const;

/** Generic shape of a secret configuration name (covers names added later). */
export const SECRET_NAME_SHAPE =
  /(?:^|_)(?:SECRET|PASSWORD|PASSWD|PRIVATE_KEY|DEPLOY_KEY|API_KEY|ACCESS_KEY|AUTH_TOKEN|ADMIN_KEY)$/;

export const isSecretName = (name: string) =>
  (SECRET_NAMES as readonly string[]).includes(name) ||
  SECRET_NAME_SHAPE.test(name);

/**
 * Names that must not appear in a client bundle at all. `BETTER_AUTH_SECRET`
 * and `AUTH_SECRET` are deliberately absent: the better-auth client ships an
 * isomorphic `env` getter that names them and resolves to undefined in the
 * browser. Their values are still checked whenever they are available locally.
 */
export const BUNDLE_FORBIDDEN_NAMES = [
  "CONNECTOR_SIGNING_SECRET",
  "MOBILE_CURSOR_SECRET",
  "SAP_USERNAME",
  "SAP_PASSWORD",
  "CONVEX_DEPLOY_KEY",
] as const;

/** Credential shapes that must never be committed or bundled. */
export const CREDENTIAL_PATTERNS: { rule: string; pattern: RegExp }[] = [
  {
    rule: "private-key-block",
    pattern:
      /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\sA-Za-z0-9+/=]{64,}-----END/,
  },
  {
    rule: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/,
  },
  { rule: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { rule: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { rule: "stripe-live-key", pattern: /\b[rs]k_live_[A-Za-z0-9]{16,}/ },
  {
    rule: "convex-deploy-key",
    pattern: /\b(?:prod|dev|preview|project):[a-z0-9-]+\|[A-Za-z0-9+/=]{40,}/,
  },
];

/** Public client-build variables: these are inlined into browser code by design. */
const CLIENT_PROCESS_ENV = /^(?:NEXT_PUBLIC_[A-Z0-9_]+|NODE_ENV)$/;
const CLIENT_IMPORT_META_ENV =
  /^(?:VITE_[A-Z0-9_]+|MODE|DEV|PROD|SSR|BASE_URL)$/;

/** Tracked filenames that only ever hold local credentials or signing material. */
const FORBIDDEN_TRACKED_FILE =
  /(?:^|\/)(?:\.env(?:\.[^/]+)?|local\.properties|Local\.xcconfig|[^/]+\.(?:pem|p12|pfx|jks|keystore|mobileprovision|p8))$/;

const TEXT_EXTENSIONS =
  /\.(?:[cm]?[jt]sx?|json|md|ya?ml|toml|txt|example|env|css|html|kts?|gradle|properties|swift|plist|xcconfig|pbxproj|xml|sh|sql|csv)$|(?:^|\/)\.env[^/]*$/;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".turbo",
  ".next",
  "dist",
  "build",
  ".gradle",
  ".kotlin",
  "DerivedData",
]);

// ---------------------------------------------------------------------------
// Pure checks (unit-tested)

/** Parse KEY=value lines from a dotenv / xcconfig / properties file. */
export function parseAssignments(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!match) continue;
    let value = match[2]!.replace(/\s+#.*$/, "").trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    result.set(match[1]!, value);
  }
  return result;
}

/** Secret values worth searching for (short values would only produce noise). */
export function collectSecretValues(
  sources: Iterable<[string, string | undefined]>,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, value] of sources)
    if (value && value.length >= 8 && isSecretName(name))
      values.set(value, name);
  return values;
}

export function scanContent(
  file: string,
  text: string,
  options: {
    secretValues?: Map<string, string>;
    forbiddenNames?: readonly string[];
    patterns?: boolean;
  } = {},
): Finding[] {
  const findings: Finding[] = [];
  for (const [value, name] of options.secretValues ?? [])
    if (text.includes(value))
      findings.push({ file, rule: "secret-value", detail: name });
  for (const name of options.forbiddenNames ?? [])
    if (new RegExp(`\\b${name}\\b`).test(text))
      findings.push({ file, rule: "secret-name", detail: name });
  if (options.patterns ?? true)
    for (const { rule, pattern } of CREDENTIAL_PATTERNS)
      if (pattern.test(text)) findings.push({ file, rule });
  return findings;
}

/** Tracked env-style files must keep every secret assignment blank. */
export function checkEnvTemplate(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [name, value] of parseAssignments(text))
    if (isSecretName(name) && value !== "")
      findings.push({
        file,
        rule: "committed-secret-assignment",
        detail: name,
      });
  return findings;
}

/** Browser code may read only public build-time variables. */
export function checkClientEnvUsage(file: string, text: string): Finding[] {
  if (/^\s*import\s+["']server-only["']/m.test(text)) return [];
  const findings: Finding[] = [];
  for (const match of text.matchAll(
    /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([^"']+)["']\s*\]|(\[))?/g,
  )) {
    const name = match[1] ?? match[2];
    if (name ? !CLIENT_PROCESS_ENV.test(name) : true)
      findings.push({
        file,
        rule: "client-reads-private-env",
        detail: name ?? "process.env (dynamic)",
      });
  }
  for (const match of text.matchAll(
    /import\.meta\.env(?:\.([A-Za-z_][A-Za-z0-9_]*))?/g,
  )) {
    const name = match[1];
    if (!name || !CLIENT_IMPORT_META_ENV.test(name))
      findings.push({
        file,
        rule: "client-reads-private-env",
        detail: name ?? "import.meta.env (dynamic)",
      });
  }
  return findings;
}

/** Build configuration must not widen what is inlined into browser bundles. */
export function checkBundlerConfig(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  if (/next\.config\./.test(file) && /\benv\s*:/.test(text))
    findings.push({ file, rule: "next-config-env-inlining" });
  if (/vite\.config\./.test(file)) {
    if (/\benvPrefix\s*:/.test(text))
      findings.push({ file, rule: "vite-env-prefix-widened" });
    if (/\bdefine\s*:/.test(text) && /process\.env|loadEnv/.test(text))
      findings.push({ file, rule: "vite-define-env-inlining" });
  }
  return findings;
}

/**
 * Turbo must not declare secrets for client builds. The root `globalEnv` still
 * lists connector variables (connector configuration is owned separately); the
 * built-bundle scan is what proves none of them reach web/PWA output.
 */
export function checkTurboConfig(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const config = JSON.parse(text) as {
    tasks?: Record<string, { env?: string[]; passThroughEnv?: string[] }>;
  };
  for (const name of [
    ...(config.tasks?.build?.env ?? []),
    ...(config.tasks?.build?.passThroughEnv ?? []),
  ])
    if (isSecretName(name))
      findings.push({ file, rule: "turbo-build-secret", detail: name });
  return findings;
}

export function checkTrackedPath(file: string): Finding[] {
  return FORBIDDEN_TRACKED_FILE.test(file) && !file.endsWith(".example")
    ? [{ file, rule: "tracked-credential-file" }]
    : [];
}

// ---------------------------------------------------------------------------
// Filesystem drivers

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function findLocalEnvFiles(root: string, dir = root, out: string[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name))
        findLocalEnvFiles(root, join(dir, entry.name), out);
    } else if (/^\.env/.test(entry.name) && !entry.name.endsWith(".example"))
      out.push(join(dir, entry.name));
  }
  return out;
}

/** Secret values known on this machine: local env files plus the process environment. */
export function loadKnownSecretValues(root: string) {
  const sources: [string, string | undefined][] = Object.entries(process.env);
  for (const file of findLocalEnvFiles(root))
    sources.push(...parseAssignments(readFileSync(file, "utf8")));
  return collectSecretValues(sources);
}

function trackedFiles(root: string): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (result.exitCode !== 0) throw new Error("git ls-files failed");
  return result.stdout.toString().split("\0").filter(Boolean);
}

const NATIVE_ROOTS = ["apps/field-android/", "apps/field-ios/"];
const CLIENT_SOURCE_ROOTS = [
  "apps/web/src/",
  "apps/pwa/src/",
  "packages/ui/src/",
];

export function auditRepository(root: string): Finding[] {
  const findings: Finding[] = [];
  const secretValues = loadKnownSecretValues(root);
  for (const file of trackedFiles(root)) {
    findings.push(...checkTrackedPath(file));
    const path = join(root, file);
    if (!TEXT_EXTENSIONS.test(file) || !existsSync(path)) continue;
    if (statSync(path).size > 2_000_000) continue;
    const text = readFileSync(path, "utf8");
    findings.push(...scanContent(file, text, { secretValues }));
    if (/(?:^|\/)\.env[^/]*$|\.(?:xcconfig|properties)$/.test(file))
      findings.push(...checkEnvTemplate(file, text));
    if (
      CLIENT_SOURCE_ROOTS.some((prefix) => file.startsWith(prefix)) &&
      /\.[cm]?[jt]sx?$/.test(file) &&
      !/\.test\.[jt]sx?$/.test(file)
    )
      findings.push(...checkClientEnvUsage(file, text));
    if (/(?:^|\/)(?:next|vite)\.config\.[cm]?[jt]s$/.test(file))
      findings.push(...checkBundlerConfig(file, text));
    if (/(?:^|\/)turbo\.json$/.test(file))
      findings.push(...checkTurboConfig(file, text));
    if (NATIVE_ROOTS.some((prefix) => file.startsWith(prefix)))
      findings.push(
        ...scanContent(file, text, {
          forbiddenNames: SECRET_NAMES,
          patterns: false,
        }),
      );
  }
  return findings;
}

/** Built artefacts that are shipped to a browser or a phone. */
export const CLIENT_BUNDLE_DIRS = [
  { dir: "apps/web/.next/static", required: true },
  { dir: "apps/pwa/dist", required: true },
  {
    dir: "apps/field-android/app/build/generated/source/buildConfig",
    required: false,
  },
];

export function auditBundles(
  root: string,
  dirs = CLIENT_BUNDLE_DIRS,
): Finding[] {
  const findings: Finding[] = [];
  const secretValues = loadKnownSecretValues(root);
  for (const { dir, required } of dirs) {
    const absolute = join(root, dir);
    if (!existsSync(absolute)) {
      if (required)
        findings.push({
          file: dir,
          rule: "bundle-missing",
          detail: "run the build first",
        });
      continue;
    }
    for (const path of walk(absolute)) {
      if (
        !/\.(?:[cm]?js|map|html|json|css|webmanifest|txt|java|kt)$/.test(path)
      )
        continue;
      findings.push(
        ...scanContent(relative(root, path), readFileSync(path, "utf8"), {
          secretValues,
          forbiddenNames: BUNDLE_FORBIDDEN_NAMES,
        }),
      );
    }
  }
  return findings;
}

export function formatFindings(findings: Finding[]): string {
  return findings
    .map(
      ({ file, rule, detail }) =>
        `  ${file}: ${rule}${detail ? ` (${detail})` : ""}`,
    )
    .join("\n");
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const args = new Set(process.argv.slice(2));
  const all = !args.has("--repo") && !args.has("--bundles");
  const findings = [
    ...(all || args.has("--repo") ? auditRepository(root) : []),
    ...(all || args.has("--bundles") ? auditBundles(root) : []),
  ];
  if (findings.length) {
    console.error(
      `Secret audit failed (${findings.length} finding${findings.length === 1 ? "" : "s"}). Values are never printed.\n${formatFindings(findings)}\nPolicy: docs/security/SECRETS_AND_CLIENT_CONFIG.md`,
    );
    process.exit(1);
  }
  console.log(
    "Secret audit passed: no credentials in tracked files or client bundles.",
  );
}
