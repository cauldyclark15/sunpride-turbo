// Lane-only helper for the Office app's live UI tests (SP-0165). Never point it at a shared or live server.
// Plans, counts and submits N stock counts as manager@ (so approver@ can decide them in Decide), after making
// sure the lane has a stock authority band that names the approver role.
//   SUNPRIDE_LANE_API=http://127.0.0.1:4620 bun apps/office-ios/scripts/lane-seed-decide.js 4
// The seed password is read from ~/.sunpride-keys/v2-test-password and never printed.
// The authority band is lane data set through SQL only when LANE_DATABASE_URL is given.
const O = process.env.SUNPRIDE_LANE_API ?? "http://127.0.0.1:4620";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(O)) throw new Error("lane API only (http://127.0.0.1:<port>)");
const pw = (await Bun.file(`${process.env.HOME}/.sunpride-keys/v2-test-password`).text()).trim();
const n = Number(process.argv[2] ?? 3);

if (process.env.LANE_DATABASE_URL) {
  const { SQL } = await import("bun");
  const db = new SQL(process.env.LANE_DATABASE_URL);
  const rows = await db`update fiscal_authority_rules set approver_roles='["approver","admin","super_admin"]'::jsonb
    where kind='stock' and role='manager' and (effective_to is null or effective_to>now()) returning id`;
  console.log("authority bands naming the approver:", rows.length);
  await db.close();
}

const s = await (await fetch(`${O}/api/auth/sign-in`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ version: 2, app: "office-ios", email: "manager@sunpride.test", password: pw }),
})).json();
const H = { authorization: `Bearer ${s.accessToken}`, "content-type": "application/json" };
const cmd = async (/** @type {string} */ a, /** @type {any} */ b) => {
  const r = await fetch(`${O}/api/v1/inventory/${a}`, { method: "POST", headers: H, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...b }) });
  const j = await r.json();
  if (r.status !== 200) throw new Error(`${a} ${r.status} ${j?.error?.message ?? ""}`);
  return j;
};
const locs = await (await fetch(`${O}/api/v1/inventory/locations`, { headers: H })).json();
const loc = locs.find((/** @type {any} */ l) => l.type === "warehouse") ?? locs[0];
for (let i = 0; i < n; i++) {
  const plan = await cmd("counts/plan", { locationId: loc.id, blindCount: false, title: `Shelf check ${i + 1}` });
  /** @type {any[]} */ const all = [];
  let cursor = null;
  do {
    const q = `sessionId=${plan.id}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const l = await (await fetch(`${O}/api/v1/inventory/counts/lines?${q}`, { headers: H })).json();
    all.push(...(l.lines ?? []));
    cursor = l.nextCursor ?? null;
  } while (cursor);
  // Count what the system expects, a little short on the first three lines (a real difference to decide).
  const lines = all.map((x, k) => ({ lineId: x.id, countedBase: k < 3 ? Math.max(0, Number(x.expected?.base ?? 0) - 2) : Number(x.expected?.base ?? 0) }));
  await cmd("counts/save-lines", { sessionId: plan.id, lines });
  await cmd("counts/submit", { sessionId: plan.id });
  console.log("submitted", plan.number);
}
