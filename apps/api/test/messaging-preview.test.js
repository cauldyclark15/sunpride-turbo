import { test, expect } from "bun:test";
import {
  fetchPreview,
  pinnedFetch,
  publicAddress,
} from "../src/domains/messaging/previews.js";
/** @param {string} html */
const page = (html) =>
  new Response(html, { headers: { "content-type": "text/html" } });
const dns = async () => [{ address: "93.184.216.34", family: 4 }];
test("SSRF rejects literal, encoded, private, metadata and IPv6 destinations before transport", async () => {
  let calls = 0;
  for (const host of [
    "127.0.0.1",
    "10.2.3.4",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.0.1",
    "2130706433",
    "0x7f000001",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[fd00::1]",
    "[2002:7f00:1::]",
    "localhost",
  ]) {
    await expect(
      fetchPreview(`http://${host}/`, {
        dns,
        fetch: async () => {
          calls++;
          return page("no");
        },
      }),
    ).rejects.toThrow();
  }
  expect(calls).toBe(0);
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(publicAddress("2606:4700:4700::1111")).toBe(true);
});
test("SSRF checks all DNS answers, every redirect and pins selected IP", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254"]) {
    let calls = 0;
    await expect(
      fetchPreview("https://public.example/", {
        dns,
        fetch: async () => {
          calls++;
          return new Response(null, {
            status: 302,
            headers: { location: `http://${ip}/private` },
          });
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }
  let calls = 0;
  await expect(
    fetchPreview("https://mixed.example/", {
      dns: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.1.2.3", family: 4 },
      ],
      fetch: async () => {
        calls++;
        return page("bad");
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  const result = await fetchPreview("https://safe.example/", {
    dns,
    fetch: async (url, ip) => {
      expect(url.hostname).toBe("safe.example");
      expect(ip.address).toBe("93.184.216.34");
      return page(
        '<title>Fallback</title><meta content="Business &amp; News" property="og:title"><meta property="og:image" content="http://127.0.0.1/private"><meta property="og:description" content="Plain words">',
      );
    },
  });
  expect(result).toEqual({
    title: "Business & News",
    description: "Plain words",
    image_url: null,
    site_name: null,
  });
});
test("preview refuses redirect overflow, non-HTML and bodies over 1 MB", async () => {
  let redirects = 0;
  await expect(
    fetchPreview("https://safe.example/", {
      dns,
      fetch: async () => {
        redirects++;
        return new Response(null, {
          status: 302,
          headers: { location: "/again" },
        });
      },
    }),
  ).rejects.toThrow();
  expect(redirects).toBe(4);
  await expect(
    fetchPreview("https://safe.example/", {
      dns,
      fetch: async () =>
        new Response("no", { headers: { "content-type": "application/pdf" } }),
    }),
  ).rejects.toThrow();
  await expect(
    fetchPreview("https://safe.example/", {
      dns,
      fetch: async () => page("x".repeat(1024 * 1024 + 1)),
    }),
  ).rejects.toThrow();
  await expect(
    fetchPreview("file:///etc/passwd", { dns, fetch: async () => page("no") }),
  ).rejects.toThrow();
});
test("preview enforces five-second total deadline including injected DNS", async () => {
  await expect(
    fetchPreview("https://slow.example/", {
      dns: () => new Promise(() => {}),
      fetch: async () => page("no"),
    }),
  ).rejects.toThrow("Preview timed out");
}, 7000);
test("the real transport connects to the pinned, already-checked address (never a second lookup)", async () => {
  // The host name below does not resolve to this machine; only the pinned address can reach it.
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new Response(
        `<title>Pinned ${new URL(req.url).hostname}</title>`,
        { headers: { "content-type": "text/html" } },
      ),
  });
  try {
    const res = await pinnedFetch(
      new URL(`http://pinned-preview.example:${server.port}/`),
      { address: "127.0.0.1", family: 4 },
      AbortSignal.timeout(5000),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<title>Pinned pinned-preview.example</title>");
  } finally {
    server.stop(true);
  }
});
