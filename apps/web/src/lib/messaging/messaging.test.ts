import { describe, expect, it, vi } from "vitest";
import { createActions } from "../../components/messaging/actions";
import { browseItems, messagingClient } from "./client";
import { EscapeStack } from "./escape";
import { CHANNEL_ID, CONVERSATIONS, ME, MESSAGES, UNREAD, message } from "./fixtures";
import { liveRegistrations, messagingKeys } from "./hooks";
import { Outbox, withPending } from "./outbox";
import {
  thumbnailSize,
  attachmentError,
  attachmentMime,
  sameOriginUploadUrl,
  uploadAttachment,
} from "./upload";

type Call = { url: string; method: string; body: unknown };

function fakeFetch(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url.split("?")[0]}`;
    if (!(key in responses))
      return new Response(JSON.stringify({ error: { code: "not_found", message: "Not found" } }), { status: 404 });
    return new Response(JSON.stringify(responses[key]), { status: 200 });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("messaging client follows the contract routes", () => {
  it("lists conversations, pages messages and sends with client_msg_id", async () => {
    const base = "/api/v1/messaging";
    const { calls, fetchImpl } = fakeFetch({
      [`GET ${base}/conversations`]: { items: CONVERSATIONS, next_cursor: "c2" },
      [`GET ${base}/conversations/${CHANNEL_ID}/messages`]: { items: MESSAGES, has_more: true },
      [`POST ${base}/conversations/${CHANNEL_ID}/messages`]: MESSAGES[1],
      [`GET ${base}/unread`]: UNREAD,
      [`DELETE ${base}/messages/m1/reactions/${encodeURIComponent("👍")}`]: {},
      [`GET ${base}/refs/search`]: [],
    });
    const client = messagingClient({ fetchImpl });
    expect((await client.listConversations()).next_cursor).toBe("c2");
    await client.listMessages(CHANNEL_ID, { before_seq: 10, thread: "p1" });
    await client.sendMessage(CHANNEL_ID, { client_msg_id: "k1", body: "hi", attachment_ids: ["a1"] });
    expect((await client.unread()).total).toBe(3);
    await client.removeReaction("m1", "👍");
    await client.searchRefs("pure", ["outlet", "product"]);
    expect(calls[1]!.url).toBe(
      `${base}/conversations/${CHANNEL_ID}/messages?before_seq=10&limit=50&thread=p1`,
    );
    expect(calls[2]).toMatchObject({
      method: "POST",
      body: { client_msg_id: "k1", body: "hi", attachment_ids: ["a1"] },
    });
    expect(calls[4]!.method).toBe("DELETE");
    expect(calls[5]!.url).toBe(`${base}/refs/search?q=pure&types=outlet%2Cproduct&limit=20`);
  });

  it("surfaces a non-member 404 as not_found", async () => {
    const { fetchImpl } = fakeFetch({});
    await expect(messagingClient({ fetchImpl }).getConversation("x")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("optimistic send", () => {
  it("shows a pending message, marks failure, and retries with the same client_msg_id", async () => {
    const outbox = new Outbox();
    const sent: string[] = [];
    let fail = true;
    const client = {
      sendMessage: vi.fn(async (_id: string, input: { client_msg_id: string }) => {
        sent.push(input.client_msg_id);
        if (fail) throw new Error("Network down");
        return message({ id: "server-1", seq: 6 });
      }),
    };
    const invalidate = vi.fn();
    const actions = createActions(client as never, invalidate, outbox);
    await actions.send({ conversationId: CHANNEL_ID, clientMsgId: "k-1", body: "hello" });
    let view = withPending(MESSAGES, outbox.list(CHANNEL_ID), ME);
    expect(view.at(-1)).toMatchObject({ body: "hello", pending: { status: "failed", error: "Network down" } });

    fail = false;
    await actions.retry("k-1");
    expect(sent).toEqual(["k-1", "k-1"]);
    expect(invalidate).toHaveBeenCalledWith(expect.arrayContaining([messagingKeys.messages(CHANNEL_ID)]));

    // The server copy arrives: the pending one disappears, nothing doubles.
    const server = [...MESSAGES, message({ id: "server-1", seq: 6, author: ME, body: "hello" })];
    view = withPending(server, outbox.list(CHANNEL_ID), ME);
    expect(view.filter((m) => m.body === "hello")).toHaveLength(1);
    outbox.settle(new Set(server.map((m) => m.id)));
    expect(outbox.list(CHANNEL_ID)).toEqual([]);
  });
});

describe("attachments", () => {
  it("accepts the contract's types and sizes only", () => {
    expect(attachmentError({ name: "a.exe", type: "application/x-msdownload", size: 10 })).toMatch(/can't be sent/);
    expect(attachmentError({ name: "big.pdf", type: "application/pdf", size: 26 * 1024 * 1024 })).toMatch(/25 MB/);
    expect(attachmentError({ name: "ok.png", type: "image/png", size: 10 })).toBeNull();
    expect(attachmentMime({ name: "data.csv", type: "application/vnd.ms-excel" })).toBe("text/csv");
    expect(attachmentMime({ name: "pack.zip", type: "application/x-zip-compressed" })).toBe("application/zip");
  });

  it("keeps thumbnails within 320 px on the longest side", () => {
    expect(thumbnailSize(1600, 1200)).toEqual({ width: 320, height: 240 });
    expect(thumbnailSize(300, 900)).toEqual({ width: 107, height: 320 });
    expect(thumbnailSize(200, 100)).toEqual({ width: 200, height: 100 });
  });

  it("claims and uploads the file, then a JPEG thumb tied to it", async () => {
    const claims: unknown[] = [];
    const puts: { url: string; mime: string }[] = [];
    const client = {
      claimAttachment: vi.fn(async (input: { role: string }) => {
        claims.push(input);
        return input.role === "file"
          ? { attachment_id: "att-1", upload_url: "/up/1", expires_at: "x" }
          : { attachment_id: "att-1t", upload_url: "/up/1t", expires_at: "x" };
      }),
    };
    const progress: number[] = [];
    const file = new File([new Uint8Array(2048)], "shelf.png", { type: "image/png" });
    const id = await uploadAttachment(file, (p) => progress.push(p), {
      client,
      digest: async () => "f".repeat(64),
      thumbnail: async () => ({ blob: new Blob([new Uint8Array(100)], { type: "image/jpeg" }), width: 320, height: 240 }),
      put: async (url, _body, mime, onProgress) => {
        puts.push({ url, mime });
        onProgress(1);
      },
    });
    expect(id).toBe("att-1");
    expect(claims).toEqual([
      { name: "shelf.png", mime: "image/png", bytes: 2048, sha256: "f".repeat(64), role: "file" },
      { name: "shelf-thumb.jpg", mime: "image/jpeg", bytes: 100, sha256: "f".repeat(64), role: "thumb", of_attachment_id: "att-1" },
    ]);
    expect(puts).toEqual([
      { url: "/up/1", mime: "image/png" },
      { url: "/up/1t", mime: "image/jpeg" },
    ]);
    expect(progress.at(-1)).toBe(1);
  });
});

describe("API shapes the web reads", () => {
  it("reads `me` from /unread and the bare /channels/browse list", () => {
    expect(UNREAD.me.id).toBe(ME.id);
    expect(browseItems([CONVERSATIONS[0]!])).toEqual([CONVERSATIONS[0]]);
    expect(browseItems(null)).toEqual([]);
    for (const c of CONVERSATIONS)
      if (c.last_message)
        expect(Object.keys(c.last_message).sort()).toEqual([
          "author",
          "body",
          "created_at",
          "deleted",
          "id",
          "seq",
        ]);
  });

  it("PUTs the capability upload URL on the web's own origin", () => {
    const url =
      "http://127.0.0.1:4310/api/v1/messaging/attachments/a1/upload?token=spu_x";
    expect(sameOriginUploadUrl(url, "https://sunpride.example")).toBe(
      "/api/v1/messaging/attachments/a1/upload?token=spu_x",
    );
    expect(sameOriginUploadUrl("https://cdn.example/x", "https://sunpride.example")).toBe(
      "https://cdn.example/x",
    );
  });
});

describe("realtime", () => {
  it("subscribes the user topic and the open conversation's topic", () => {
    const registrations = liveRegistrations(ME.id, CHANNEL_ID);
    expect(registrations.map((r) => r.topic)).toEqual([
      `messaging.user:${ME.id}`,
      `messaging.conv:${CHANNEL_ID}`,
    ]);
    expect(registrations[0]!.keys).toContainEqual(messagingKeys.unread);
    expect(registrations[1]!.keys).toContainEqual(messagingKeys.messages(CHANNEL_ID));
    expect(liveRegistrations(null, null)).toEqual([]);
  });
});

describe("Escape closes the panel opened last", () => {
  it("closes the top panel only, then the next", () => {
    const target = new EventTarget();
    const stack = new EscapeStack(() => target);
    const closed: string[] = [];
    const releaseThread = stack.push(() => closed.push("thread"));
    const releaseLightbox = stack.push(() => closed.push("lightbox"));
    const escape = () => {
      const event = new Event("keydown", { cancelable: true });
      Object.assign(event, { key: "Escape" });
      target.dispatchEvent(event);
    };
    escape();
    expect(closed).toEqual(["lightbox"]);
    releaseLightbox();
    escape();
    expect(closed).toEqual(["lightbox", "thread"]);
    releaseThread();
    escape();
    expect(closed).toHaveLength(2);
    expect(stack.size()).toBe(0);
  });
});
