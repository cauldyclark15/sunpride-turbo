import { expect, test } from "bun:test";
import { createDb } from "@sunpride/db/client";
import { startHarness } from "./harness.js";

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
