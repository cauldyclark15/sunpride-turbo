import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { startHarness, profileStore, boundDevice } from "./harness.js";
import { install } from "../src/domains/integrity/index.js";
import { stageApk } from "../src/domains/integrity/apk-artifacts.js";
import { sha256Hex } from "../src/core/util.js";

const signed = process.env.SP_TEST_SIGNED_APK ? test : test.skip;
signed(
  "F-006 genuine signed APK inspection, publication, native discovery, exact download and withdrawal",
  async () => {
    const dir = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "finish-a-release-"),
    );
    const env = { SP_APP_RELEASE_DIR: dir };
    const m = await stageApk(process.env.SP_TEST_SIGNED_APK ?? "", {
      ...process.env,
      ...env,
    });
    const h = await startHarness({ installers: [install], env });
    try {
      const people = profileStore(h),
        unit = crypto.randomUUID();
      h.setHooks({ unitInScope: async () => true });
      await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active',now()-interval '1 day')`;
      const phone = await boundDevice(h, people, {
        app: "field-android",
        role: "super_admin",
        orgUnitId: unit,
      });
      const p = phone.profile;
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${phone.userId},${phone.userId},${p.name},${phone.email},${p.role},'active',${unit})`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','SAMPLE','SAMPLE')`;
      const headers = {
        authorization: `Bearer ${phone.access}`,
        "content-type": "application/json",
      };
      expect((await h.fetch("/api/v1/integrity/app-releases")).status).toBe(
        401,
      );
      const publish = await h.fetch("/api/v1/integrity/app-releases/publish", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sha256: m.sha256,
          notes: "SAMPLE release-channel proof using an existing signed APK",
          effectiveFrom: Date.now(),
        }),
      });
      const r = await publish.json();
      expect(publish.status, JSON.stringify(r)).toBe(200);
      const read = await h.fetch("/api/v1/integrity/app-releases", { headers });
      const register = await read.json();
      expect(register.releases[0].sha256).toBe(m.sha256);
      const latest = () =>
        h.fetch(
          `/api/v1/app-releases/latest?packageName=${m.packageName}&versionCode=0`,
          { headers },
        );
      expect((await (await latest()).json()).release.id).toBe(r.id);
      expect(
        (
          await (
            await h.fetch(
              `/api/v1/app-releases/latest?packageName=${m.packageName}&versionCode=${m.versionCode}`,
              { headers },
            )
          ).json()
        ).release,
      ).toBeNull();
      const download = await h.fetch(`/api/v1/app-releases/${r.id}/apk`, {
        headers,
      });
      expect(download.status).toBe(200);
      expect(sha256Hex(new Uint8Array(await download.arrayBuffer()))).toBe(
        m.sha256,
      );
      expect(
        (
          await h.fetch("/api/v1/integrity/app-releases/withdraw", {
            method: "POST",
            headers,
            body: JSON.stringify({ id: r.id }),
          })
        ).status,
      ).toBe(200);
      expect((await (await latest()).json()).release).toBeNull();
      const after = await (
        await h.fetch("/api/v1/integrity/app-releases", { headers })
      ).json();
      expect(after.releases[0].withdrawn).toBe(true);
      expect(
        (await h.fetch(`/api/v1/app-releases/${r.id}/apk`, { headers })).status,
      ).toBe(404);
    } finally {
      await h.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  15000,
);
