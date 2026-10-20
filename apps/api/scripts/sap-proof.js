#!/usr/bin/env bun
// F-001/F-003/F-005 acceptance rig. Scope: ONLY the isolated ssap lane DB and own pids.
import { mkdir, chmod } from "node:fs/promises";
import { createDb, tx } from "../../../packages/db/src/client.js";
import { migrate } from "../../../packages/db/src/migrate.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { seedSapDemo } from "../../../packages/db/seed/sap.js";
import { createApp } from "../src/core/app.js";
import {
  enqueueSapPosting,
  runOutbox,
} from "../src/domains/integration/outbox.js";

const directory = `${process.env.HOME}/.hermes/cache/scratch/sp-v3/sap-proof`;
await mkdir(directory, { recursive: true });
const url = (
  await Bun.file(`${process.env.HOME}/.sunpride-keys/pg-lane-ssap-url`).text()
).trim();
if (new URL(url).pathname !== "/sunpride_lane_ssap")
  throw new Error("Refusing a non-lane database");
const db = createDb(url, { max: 5 });
const env = {
  ...process.env,
  SAP_MODE: "mock",
  SAP_ORIGIN: "http://127.0.0.1:4435",
  SAP_TIMEOUT_MS: "1000",
  SYNC_CURSOR_SECRET:
    process.env.SYNC_CURSOR_SECRET ?? crypto.randomUUID() + crypto.randomUUID(),
  FILES_DIR: directory + "/media",
};
/** @type {ReturnType<typeof Bun.spawn>|null} */ let mock = null;
/** @type {ReturnType<typeof createApp>|null} */ let app = null;
async function start() {
  mock = Bun.spawn(
    [
      process.execPath,
      new URL("../../sap-mock/src/server.js", import.meta.url).pathname,
    ],
    {
      env: {
        ...process.env,
        SAP_MOCK_DB: directory + "/sap.sqlite",
        PORT: "4435",
      },
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  for (let i = 0; i < 100; i++) {
    if (mock.exitCode !== null)
      throw new Error(
        "The proof mock could not start; no other process was stopped",
      );
    try {
      if ((await fetch(env.SAP_ORIGIN + "/healthz")).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Mock startup failed");
}
/** @param {string} path @param {any} body */
async function control(path, body) {
  const r = await fetch(env.SAP_ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Mock control failed");
}
/** @param {string} kind */
async function queue(kind) {
  const id = crypto.randomUUID();
  const document = {
    sourceType: "proof",
    sourceId: id,
    customerCode: "MOCK-C1",
    currency: "PHP",
    amountCentavos: 100,
    occurredAt: Date.now(),
    lines: [],
    facts: { sample: true, label: "Sample SAP recovery proof" },
  };
  const q = await tx(db, (t) =>
    enqueueSapPosting(t, { kind, sourceType: "proof", sourceId: id, document }),
  );
  return { ...q, sourceId: id, document, effectId: `${kind}:proof:${id}` };
}
async function shutdown() {
  await app?.stop();
  if (mock && mock.exitCode === null) {
    mock.kill("SIGTERM");
    await mock.exited;
  }
  await db.close();
  process.exit(0);
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
try {
  console.log("F-023 migrating isolated SAP lane");
  await migrate(db);
  const seed = await seedDemo(db);
  console.log("F-001 reconciling existing sample company through mock SAP");
  await start();
  const replicas = await seedSapDemo(db, env);
  console.log("F-015 replica reconciliation", JSON.stringify(replicas));
  app = createApp({ db, dbUrl: url, env });
  await app.start({ port: 4430, schedule: false });
  const outage = await queue("invoice");
  await control("/control/fault", {
    target: "invoice",
    mode: "accept_slow",
    count: 1,
    delayMs: 10000,
  });
  const pending = runOutbox(db, { env, limit: 1 });
  let seen = false;
  for (let i = 0; i < 100; i++) {
    const r = await fetch(env.SAP_ORIGIN + "/control/receipts").then((r) =>
      r.json(),
    );
    if (r.rows.some((/** @type {any} */ x) => x.effect === outage.effectId)) {
      seen = true;
      break;
    }
    await Bun.sleep(20);
  }
  if (!seen)
    throw new Error("Outage proof did not reach the accepted-send window");
  mock?.kill("SIGKILL");
  await mock?.exited;
  await pending;
  const [retained] =
    await db`select status,payload_hash from integration_events where id=${outage.id}`;
  if (retained.status !== "failed")
    throw new Error("Outbox was not retained after the real SAP process kill");
  await start();
  await db`update integration_events set next_attempt_at=now() where id=${outage.id}`;
  await runOutbox(db, { env });
  const [recovered] =
    await db`select status,payload_hash,external_document_number from integration_events where id=${outage.id}`;
  const receipts = await fetch(env.SAP_ORIGIN + "/control/receipts").then((r) =>
    r.json(),
  );
  const copies = receipts.rows.filter(
    (/** @type {any} */ x) => x.effect === outage.effectId,
  ).length;
  if (
    recovered.status !== "completed" ||
    recovered.payload_hash !== retained.payload_hash ||
    copies !== 1
  )
    throw new Error("Outage reconciliation failed");
  const quarantine = await tx(db, (t) =>
    enqueueSapPosting(t, {
      kind: "invoice",
      sourceType: "proof",
      sourceId: outage.sourceId,
      document: { ...outage.document, amountCentavos: 101 },
    }),
  );
  if (!quarantine.quarantined)
    throw new Error("Changed payload was not quarantined");
  const dead = await queue("payment");
  await control("/control/fault", {
    target: "payment",
    mode: "reject",
    count: 1,
  });
  await runOutbox(db, { env });
  const [deadRow] =
    await db`select status from integration_events where id=${dead.id}`;
  if (deadRow.status !== "dead_letter")
    throw new Error("Console fixture is not a dead letter");
  const password = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/v2-test-password`).text()
  ).trim();
  const response = await fetch("http://127.0.0.1:4430/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@sunpride.test", password }),
  });
  if (!response.ok) throw new Error("Sample office sign-in failed");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Sample office session missing");
  await Bun.write(directory + "/session-cookie", cookie);
  await chmod(directory + "/session-cookie", 0o600);
  const before = await fetch(
    "http://127.0.0.1:4430/api/v1/integration/events",
    { headers: { cookie } },
  ).then((r) => r.json());
  await Bun.write(
    directory + "/before-retry.json",
    JSON.stringify(before, null, 2),
  );
  const evidence = {
    source: "sample",
    seed: {
      salesTodayCentavos: seed.salesTodayCentavos,
      salesMtdCentavos: seed.salesMtdCentavos,
    },
    replicas,
    outage: {
      realSignal: "SIGKILL",
      acceptedBeforeKill: true,
      retainedStatus: retained.status,
      recoveredStatus: recovered.status,
      requestHashPreserved: true,
      sapDocumentNumber: recovered.external_document_number,
      sapCopies: copies,
    },
    changedPayloadQuarantined: quarantine.quarantined,
    deadLetterId: dead.id,
    deadEffectId: dead.effectId,
    apiOrigin: "http://127.0.0.1:4430",
  };
  await Bun.write(
    directory + "/evidence.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    "F-003 actual SIGKILL recovery: one SAP receipt, unchanged hash, no lost instruction",
  );
  console.log(
    "F-005 console ready with a rejected sample payment; retry it through the UI",
  );
  console.log("PROOF_READY " + directory + "/evidence.json");
  // Keep only our proof API/mock alive while the console is inspected; do not touch showcase.
  await new Promise(() => {});
} catch (e) {
  console.error(e instanceof Error ? e.message : "SAP proof failed");
  await app?.stop();
  if (mock && mock.exitCode === null) {
    mock.kill("SIGTERM");
    await mock.exited;
  }
  await db.close();
  process.exit(1);
}
