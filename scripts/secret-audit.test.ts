import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditBundles,
  auditRepository,
  checkBundlerConfig,
  checkClientEnvUsage,
  checkEnvTemplate,
  checkTrackedPath,
  checkTurboConfig,
  collectSecretValues,
  formatFindings,
  isSecretName,
  parseAssignments,
  scanContent,
} from "./secret-audit";

const root = join(import.meta.dir, "..");
const fakeSecret = "s3cr3t-value-that-must-not-ship-0001";

describe("secret configuration names", () => {
  test("classifies known and generic secret names", () => {
    for (const name of [
      "BETTER_AUTH_SECRET",
      "CONNECTOR_SIGNING_SECRET",
      "MOBILE_CURSOR_SECRET",
      "SAP_PASSWORD",
      "SAP_USERNAME",
      "CONVEX_DEPLOY_KEY",
      "NEW_VENDOR_API_KEY",
    ])
      expect(isSecretName(name)).toBe(true);
    for (const name of [
      "NEXT_PUBLIC_CONVEX_URL",
      "VITE_CONVEX_SITE_URL",
      "CONVEX_SITE_URL",
      "SAP_BASE_URL",
      "CONNECTOR_ID",
    ])
      expect(isSecretName(name)).toBe(false);
  });

  test("parses env, xcconfig and properties assignments", () => {
    const parsed = parseAssignments(
      `# comment\nexport A=1\nB = "two" # trailing\nC=\n// xcconfig comment\nsdk.dir=/x`,
    );
    expect([...parsed]).toEqual([
      ["A", "1"],
      ["B", "two"],
      ["C", ""],
      ["sdk.dir", "/x"],
    ]);
  });

  test("collects only secret values long enough to search for", () => {
    const values = collectSecretValues([
      ["CONNECTOR_SIGNING_SECRET", fakeSecret],
      ["SAP_PASSWORD", "short"],
      ["NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud"],
    ]);
    expect([...values]).toEqual([[fakeSecret, "CONNECTOR_SIGNING_SECRET"]]);
  });
});

describe("content scanning", () => {
  test("reports a leaked value by name only", () => {
    const findings = scanContent("bundle.js", `const k="${fakeSecret}"`, {
      secretValues: new Map([[fakeSecret, "CONNECTOR_SIGNING_SECRET"]]),
    });
    expect(findings).toEqual([
      {
        file: "bundle.js",
        rule: "secret-value",
        detail: "CONNECTOR_SIGNING_SECRET",
      },
    ]);
    expect(formatFindings(findings)).not.toContain(fakeSecret);
  });

  test("detects credential shapes but not redacted examples", () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(80)}\n-----END PRIVATE KEY-----`;
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"x".repeat(43)}`;
    const rules = (text: string) => scanContent("f", text).map((f) => f.rule);
    expect(rules(pem)).toEqual(["private-key-block"]);
    expect(rules(jwt)).toEqual(["jwt"]);
    // Built at runtime so this tracked file never holds the literal shape.
    expect(rules(["AKIA", "ABCDEFGHIJKLMNOP"].join(""))).toEqual([
      "aws-access-key",
    ]);
    expect(rules(`"-----BEGIN PRIVATE KEY-----"`)).toEqual([]);
    expect(rules(`let jwt = "eyJhbG...dXJl"`)).toEqual([]);
  });

  test("matches forbidden names on word boundaries", () => {
    const scan = (text: string) =>
      scanContent("f", text, {
        forbiddenNames: ["SAP_PASSWORD"],
        patterns: false,
      });
    expect(scan(`env.SAP_PASSWORD`)).toHaveLength(1);
    expect(scan(`"INVALID_EMAIL_OR_PASSWORD"`)).toHaveLength(0);
  });
});

describe("configuration rules", () => {
  test("tracked env templates keep secrets blank", () => {
    expect(
      checkEnvTemplate(
        ".env.example",
        `CONNECTOR_SIGNING_SECRET=\nSAP_PASSWORD=\nCONVEX_URL=https://x.convex.cloud`,
      ),
    ).toEqual([]);
    expect(
      checkEnvTemplate(".env.example", `BETTER_AUTH_SECRET=changeme123`),
    ).toEqual([
      {
        file: ".env.example",
        rule: "committed-secret-assignment",
        detail: "BETTER_AUTH_SECRET",
      },
    ]);
  });

  test("forbids tracked credential files but allows templates", () => {
    for (const file of [
      ".env",
      "apps/web/.env.local",
      "packages/backend/.env.production",
      "apps/field-android/local.properties",
      "apps/field-ios/Config/Local.xcconfig",
      "certs/server.pem",
      "apps/field-android/release.jks",
    ])
      expect(checkTrackedPath(file)).toHaveLength(1);
    for (const file of [
      ".env.example",
      "packages/backend/.env.deployment.example",
      "apps/field-ios/Config/Dev.xcconfig",
      "apps/web/src/lib/env.ts",
    ])
      expect(checkTrackedPath(file)).toEqual([]);
  });

  test("browser code reads only public build variables", () => {
    expect(
      checkClientEnvUsage(
        "a.tsx",
        `process.env.NEXT_PUBLIC_CONVEX_URL; process.env.NODE_ENV; import.meta.env.VITE_CONVEX_URL; import.meta.env.DEV`,
      ),
    ).toEqual([]);
    const details = checkClientEnvUsage(
      "a.tsx",
      `process.env.BETTER_AUTH_SECRET; process.env["SAP_PASSWORD"]; process.env[name]; import.meta.env.SECRET; import.meta.env`,
    ).map((f) => f.detail);
    expect(details).toEqual([
      "BETTER_AUTH_SECRET",
      "SAP_PASSWORD",
      "process.env (dynamic)",
      "SECRET",
      "import.meta.env (dynamic)",
    ]);
    expect(
      checkClientEnvUsage(
        "route.ts",
        `import "server-only";\nprocess.env.BETTER_AUTH_SECRET`,
      ),
    ).toEqual([]);
  });

  test("bundler configs must not inline extra environment", () => {
    expect(
      checkBundlerConfig("apps/web/next.config.ts", `{ env: { A } }`),
    ).toHaveLength(1);
    expect(
      checkBundlerConfig("apps/pwa/vite.config.ts", `{ envPrefix: "" }`),
    ).toHaveLength(1);
    expect(
      checkBundlerConfig(
        "apps/pwa/vite.config.ts",
        `{ define: { k: process.env.X } }`,
      ),
    ).toHaveLength(1);
    expect(
      checkBundlerConfig(
        "apps/web/next.config.ts",
        `{ transpilePackages: ["@sunpride/ui"] }`,
      ),
    ).toEqual([]);
  });

  test("turbo keeps secrets out of global and build environments", () => {
    const findings = checkTurboConfig(
      "turbo.json",
      JSON.stringify({
        globalEnv: ["CONVEX_SITE_URL", "SAP_PASSWORD"],
        tasks: { build: { env: ["NEXT_PUBLIC_CONVEX_URL", "AUTH_SECRET"] } },
      }),
    );
    expect(findings.map((f) => `${f.rule}:${f.detail}`)).toEqual([
      "turbo-global-secret:SAP_PASSWORD",
      "turbo-build-secret:AUTH_SECRET",
    ]);
  });
});

describe("bundle audit", () => {
  test("fails when a client bundle carries a known secret value or name", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-audit-"));
    const previous = process.env.CONNECTOR_SIGNING_SECRET;
    try {
      mkdirSync(join(dir, "out/chunks"), { recursive: true });
      writeFileSync(join(dir, "out/chunks/ok.js"), "console.log(1)");
      writeFileSync(
        join(dir, "out/chunks/leak.js"),
        `fetch(u,{headers:{k:"${fakeSecret}"}});env.MOBILE_CURSOR_SECRET`,
      );
      process.env.CONNECTOR_SIGNING_SECRET = fakeSecret;
      const findings = auditBundles(dir, [
        { dir: "out", required: true },
        { dir: "missing-optional", required: false },
      ]);
      expect(findings.map((f) => `${f.file}:${f.rule}:${f.detail}`)).toEqual([
        "out/chunks/leak.js:secret-value:CONNECTOR_SIGNING_SECRET",
        "out/chunks/leak.js:secret-name:MOBILE_CURSOR_SECRET",
      ]);
      expect(auditBundles(dir, [{ dir: "absent", required: true }])).toEqual([
        {
          file: "absent",
          rule: "bundle-missing",
          detail: "run the build first",
        },
      ]);
    } finally {
      if (previous === undefined) delete process.env.CONNECTOR_SIGNING_SECRET;
      else process.env.CONNECTOR_SIGNING_SECRET = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("repository", () => {
  test("tracked files, client sources and build config pass the audit", () => {
    const findings = auditRepository(root);
    expect(formatFindings(findings)).toBe("");
  });
});
