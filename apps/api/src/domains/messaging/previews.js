import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import http from "node:http";
import https from "node:https";
import { enqueue, registerJob } from "../../core/jobs.js";
import { publish } from "../../core/realtime.js";
import { sha256Hex } from "../../core/util.js";

const denied = new BlockList();
for (const [address, prefix] of /** @type {[string,number][]} */ ([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]))
  denied.addSubnet(address, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const denied6 = new BlockList();
for (const [ip, prefix] of /** @type {[string,number][]} */ ([
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]))
  denied6.addSubnet(ip, prefix, "ipv6");
/** @param {string} address */
export function publicAddress(address) {
  const version = isIP(address);
  return version === 4
    ? !denied.check(address, "ipv4")
    : version === 6 &&
        global6.check(address, "ipv6") &&
        !denied6.check(address, "ipv6");
}
/** @typedef {{dns?:(host:string)=>Promise<Array<{address:string,family:number}>>,fetch?:(url:URL,address:{address:string,family:number},signal:AbortSignal)=>Promise<Response>}} PreviewIO */
/** @param {URL} url @param {PreviewIO} io */
async function target(url, io) {
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Unsafe URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    /\.(localhost|local|internal|home|test|invalid)$/.test(host) ||
    host.endsWith(".")
  )
    throw Error("Unsafe host");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await (io.dns ?? ((h) => lookup(h, { all: true, verbatim: true })))(host);
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw Error("Non-public destination");
  return /** @type {{address:string,family:number}} */ (addresses[0]);
}
/** Connect to the checked IP, not a second resolver lookup. Disable proxy/connection
 * reuse; TLS still verifies the original URL hostname. Return a capped plain response.
 * @param {URL} url @param {{address:string,family:number}} address @param {AbortSignal} signal */
export function pinnedFetch(url, address, signal) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        agent: false,
        signal,
        headers: {
          accept: "text/html",
          "accept-encoding": "identity",
          "user-agent": "SunprideLinkPreview/1.0",
        },
        // Bun (and Node with `all`) asks for the list form; answer both forms
        // with the one checked address.
        lookup: (/** @type {any} */ _host, /** @type {any} */ options, /** @type {any} */ cb) =>
          options?.all
            ? cb(null, [{ address: address.address, family: address.family }])
            : cb(null, address.address, address.family),
      },
      (res) => {
        const status = res.statusCode ?? 500;
        if (status >= 300 && status < 400) {
          res.destroy();
          resolve(
            new Response(null, {
              status,
              headers: { location: String(res.headers.location ?? "") },
            }),
          );
          return;
        }
        if (
          status !== 200 ||
          !String(res.headers["content-type"] ?? "")
            .toLowerCase()
            .includes("text/html")
        ) {
          res.destroy();
          reject(Error("Not an HTML page"));
          return;
        }
        if (Number(res.headers["content-length"] ?? 0) > 1024 * 1024) {
          res.destroy();
          reject(Error("Page too large"));
          return;
        }
        /** @type {Buffer[]} */ const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            res.destroy(Error("Page too large"));
          } else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
/** @param {string} value */
function clean(value) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:amp|quot|apos|lt|gt|#39|#(\d+)|#x([\da-f]+));/gi,
      (m, d, h) => {
        if (d || h) {
          const n = Number.parseInt(d ?? h, d ? 10 : 16);
          return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
        }
        return (
          /** @type {Record<string,string>} */ ({
            "&amp;": "&",
            "&quot;": '"',
            "&apos;": "'",
            "&#39;": "'",
            "&lt;": "<",
            "&gt;": ">",
          })[m.toLowerCase()] ?? m
        );
      },
    )
    .trim()
    .slice(0, 1000);
}
/** @param {string} html @param {URL} url */
export function metadata(html, url) {
  /** @type {Record<string,string>} */ const tags = {};
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    /** @type {Record<string,string>} */ const attrs = {};
    for (const a of match[0].matchAll(
      /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    ))
      attrs[(a[1] ?? "").toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    const key = attrs.property ?? attrs.name;
    if (key?.startsWith("og:") && attrs.content)
      tags[key.toLowerCase()] = clean(attrs.content);
  }
  let image = null;
  try {
    const u = new URL(tags["og:image"] ?? "", url);
    if (
      tags["og:image"] &&
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
    )
      image = u.href;
  } catch {}
  return {
    title:
      tags["og:title"] ??
      (clean(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "") ||
        null),
    description: tags["og:description"] ?? null,
    image_url: image,
    site_name: tags["og:site_name"] ?? null,
  };
}
/** All network/DNS operations are injectable. One deadline includes DNS, redirects
 * and streaming, so slow-drip pages cannot extend the five-second budget.
 * @param {string} raw @param {PreviewIO} [io] */
export async function fetchPreview(raw, io = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Error("Preview timed out"));
    }, 5000);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        let url = new URL(raw);
        for (let redirects = 0; ; redirects++) {
          const address = await target(url, io);
          const res = await (io.fetch ?? pinnedFetch)(
            url,
            address,
            controller.signal,
          );
          if (res.status >= 300 && res.status < 400) {
            await res.body?.cancel();
            if (redirects >= 3 || !res.headers.get("location"))
              throw Error("Too many redirects");
            url = new URL(
              /** @type {string} */ (res.headers.get("location")),
              url,
            );
            continue;
          }
          if (
            res.status !== 200 ||
            !(res.headers.get("content-type") ?? "")
              .toLowerCase()
              .includes("text/html")
          )
            throw Error("Not an HTML page");
          if (Number(res.headers.get("content-length") ?? 0) > 1024 * 1024)
            throw Error("Page too large");
          const reader = res.body?.getReader();
          if (!reader) throw Error("Empty page");
          /** @type {Uint8Array[]} */ const chunks = [];
          let size = 0;
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            size += r.value.length;
            if (size > 1024 * 1024) {
              await reader.cancel();
              throw Error("Page too large");
            }
            chunks.push(r.value);
          }
          const html = Buffer.concat(chunks).toString("utf8");
          const result = metadata(html, url);
          // A malicious page must not hand the clients a private-network image URL.
          if (result.image_url) {
            try {
              await target(new URL(result.image_url), io);
            } catch {
              result.image_url = null;
            }
          }
          return result;
        }
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
/** @param {any} db @param {any} row */
export async function saveLinks(db, row) {
  await db`delete from chat_message_links where message_id=${row.id}`;
  const urls = [
    ...new Set(
      (row.body.match(/https?:\/\/[^\s<>"']+/g) ?? []).map(
        (/** @type {string} */ s) => s.replace(/[.,;!?\])]+$/, ""),
      ),
    ),
  ].slice(0, 3);
  for (let position = 0; position < urls.length; position++) {
    const url = urls[position];
    if (url.length > 2000) continue;
    const hash = sha256Hex(url);
    await db`insert into chat_link_previews(url_hash,url) values(${hash},${url}) on conflict(url_hash) do nothing`;
    await db`insert into chat_message_links(message_id,url_hash,position) values(${row.id},${hash},${position})`;
    const [p] =
      await db`select status from chat_link_previews where url_hash=${hash}`;
    if (p.status === "pending")
      await enqueue(db, {
        kind: "messaging.link-preview",
        key: hash,
        payload: { hash },
      });
  }
}
/** @param {any} platform @param {PreviewIO} [io] */
export function installPreviews(platform, io = {}) {
  registerJob("messaging.link-preview", async ({ db, payload }) => {
    const [p] =
      await db`select * from chat_link_previews where url_hash=${payload.hash}`;
    if (!p || p.status !== "pending") return;
    try {
      const result = /** @type {any} */ (await fetchPreview(p.url, io));
      await db`update chat_link_previews set title=${result.title},description=${result.description},image_url=${result.image_url},site_name=${result.site_name},status='ready',fetched_at=now() where url_hash=${p.url_hash}`;
    } catch {
      await db`update chat_link_previews set status='failed',fetched_at=now() where url_hash=${p.url_hash}`;
    }
    const conversations =
      await db`select distinct m.conversation_id from chat_message_links l join chat_messages m on m.id=l.message_id where l.url_hash=${p.url_hash} and m.deleted_at is null`;
    for (const c of conversations)
      await publish(db, `messaging.conv:${c.conversation_id}`);
  });
}
/** @param {any} db @param {string} id */
export async function links(db, id) {
  return db`select p.url,p.title,p.description,p.image_url,p.site_name,p.status from chat_message_links l join chat_link_previews p on p.url_hash=l.url_hash where l.message_id=${id} order by l.position`;
}
