import { afterEach, describe, expect, it, vi } from "vitest";
import { draftKey, loadDraft, saveDraft } from "../messaging/drafts";
import { createAuthActions, fetchMe } from "./client";

// SP-0169 go-live rule: an ending session never deletes unsent work; an explicit sign-out clears message drafts.
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
  };
}

function respond(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("message drafts and session end", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps drafts when the session ends (401) and on a new sign-in, clears them on sign-out", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    if (typeof window !== "undefined")
      Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
    else vi.stubGlobal("window", { localStorage: storage });
    const key = draftKey("u1", "c1");
    saveDraft(key, "half-written", [], storage);

    expect(await fetchMe(undefined, respond(401, { error: { code: "session_invalid" } }))).toBeNull();
    expect(loadDraft(key, storage)?.text).toBe("half-written");

    await createAuthActions(undefined, undefined, respond(200, { ok: true })).signIn({
      email: "a@b.c",
      password: "x",
    });
    expect(loadDraft(key, storage)?.text).toBe("half-written");

    await createAuthActions(undefined, undefined, respond(200, {})).signOut();
    expect(loadDraft(key, storage)).toBeNull();
  });
});
