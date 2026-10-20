import { expect, test } from "bun:test";
import { createDb } from "@sunpride/db/client";
import { dropTestDatabase, startHarness } from "./harness.js";

const database = "sunpride_lane_core_t0123456789ab";
const signalDenied = () =>
  Object.assign(new Error("permission denied to terminate process"), {
    errno: "42501",
    routine: "TerminateOtherDBBackends",
  });

test("F-025 normal harness cleanup retains FORCE for its own clients", async () => {
  /** @type {string[]} */ const calls = [];
  await dropTestDatabase(
    {
      unsafe: async (/** @type {string} */ q) => {
        calls.push(q);
      },
    },
    database,
  );
  expect(calls).toEqual([`drop database if exists ${database} with (force)`]);
});

test("F-025 native worker signal refusal retries an ordinary owner-authorized drop", async () => {
  /** @type {string[]} */ const calls = [];
  await dropTestDatabase(
    {
      unsafe: async (/** @type {string} */ q) => {
        calls.push(q);
        if (calls.length === 1) throw signalDenied();
      },
    },
    database,
  );
  expect(calls).toEqual([
    `drop database if exists ${database} with (force)`,
    `drop database if exists ${database}`,
  ]);
});

test("F-025 cleanup does not retry or hide unrelated database failures", async () => {
  const denied = Object.assign(new Error("database permission refused"), {
    errno: "42501",
    routine: "other_routine",
  });
  let attempts = 0;
  await expect(
    dropTestDatabase(
      {
        unsafe: async () => {
          attempts++;
          throw denied;
        },
      },
      database,
    ),
  ).rejects.toBe(denied);
  expect(attempts).toBe(1);
});

test("F-025 occupied ordinary fallback remains a hard cleanup failure", async () => {
  const occupied = Object.assign(
    new Error("database is being accessed by other users"),
    { errno: "55006" },
  );
  let attempts = 0;
  await expect(
    dropTestDatabase(
      {
        unsafe: async () => {
          attempts++;
          throw attempts === 1 ? signalDenied() : occupied;
        },
      },
      database,
    ),
  ).rejects.toBe(occupied);
  expect(attempts).toBe(2);
});

test("F-025 cleanup refuses a database outside the disposable harness prefix", async () => {
  let queried = false;
  await expect(
    dropTestDatabase(
      {
        unsafe: async () => {
          queried = true;
        },
      },
      "sunpride",
    ),
  ).rejects.toThrow("non-harness database");
  expect(queried).toBe(false);
});

test("F-025 disposable harness closes and removes its database without signal or superuser privileges", async () => {
  const h = await startHarness({ installers: [] });
  const url = new URL(h.dbUrl);
  const name = url.pathname.slice(1);
  expect(name).toMatch(/^sunpride_lane_[a-z0-9_]+_t[a-f0-9]{12}$/);
  url.pathname = "/postgres";
  const observer = createDb(url.toString(), { max: 1 });
  let closeAttempted = false;
  try {
    const [role] =
      await h.db`select rolsuper,rolcreaterole,pg_has_role(current_user,'pg_signal_backend','MEMBER') as signal_privilege from pg_roles where rolname=current_user`;
    expect(role.rolsuper).toBe(false);
    expect(role.rolcreaterole).toBe(false);
    expect(role.signal_privilege).toBe(false);
    closeAttempted = true;
    await h.close();
    const [retained] =
      await observer`select exists(select 1 from pg_database where datname=${name}) as present`;
    expect(retained.present).toBe(false);
  } finally {
    try {
      if (!closeAttempted) await h.close();
    } finally {
      await observer.close();
    }
  }
});
