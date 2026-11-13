import { expect, test } from "bun:test";
import { startHarness, createUser } from "./harness.js";
import { domainInstallers } from "../src/domains/index.js";

/** The e2e harness's documented "SAP_OFF=1" restart: SAP_MODE=off must really turn SAP ownership off. */
async function permissions(/** @type {Record<string,string>} */ env) {
  const h = await startHarness({ installers: domainInstallers, env });
  try {
    const password = "sap-off-test-only-password";
    await createUser(h, "boss@example.com", password);
    const r = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "boss@example.com", password }),
    });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
    const p = await h.fetch("/api/v1/org/permissions", { headers: { cookie } });
    expect(p.status).toBe(200);
    return { body: /** @type {any} */ (await p.json()), mode: h.env.SAP_MODE };
  } finally {
    await h.close();
  }
}

test("SAP_MODE=off: the office owns masters and prices", async () => {
  const off = await permissions({ SAP_MODE: "off" });
  expect(off.mode).toBeUndefined();
  expect(off.body.sapOwnsMasters).toBe(false);
  expect(off.body.sapOwnsPrices).toBe(false);
}, 120000);

test("SAP_MODE unset still means the local SAP mock owns them", async () => {
  const on = await permissions({});
  expect(on.mode).toBe("mock");
  expect(on.body.sapOwnsMasters).toBe(true);
  expect(on.body.sapOwnsPrices).toBe(true);
}, 120000);
