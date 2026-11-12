import { describe, expect, it } from "vitest";
import {
  DRAFT_MAX_AGE_MS,
  clearDraft,
  draftKey,
  forgetDrafts,
  loadDraft,
  saveDraft,
} from "./drafts";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("unsent message drafts", () => {
  it("keeps one draft per person, conversation and thread", () => {
    const store = memoryStorage();
    const dm = draftKey("me", "conv-1");
    const thread = draftKey("me", "conv-1", "msg-9");
    const other = draftKey("someone-else", "conv-1");
    expect(new Set([dm, thread, other]).size).toBe(3);
    saveDraft(
      dm,
      "Hi @Loren, about the price list",
      [{ label: "@Loren", token: "<@user:1>" }],
      store,
      1000,
    );
    saveDraft(thread, "replying here", [], store, 1000);
    expect(loadDraft(dm, store, 2000)).toEqual({
      text: "Hi @Loren, about the price list",
      inserts: [{ label: "@Loren", token: "<@user:1>" }],
      at: 1000,
    });
    expect(loadDraft(thread, store, 2000)?.text).toBe("replying here");
    expect(loadDraft(other, store, 2000)).toBeNull();
  });

  it("removes the draft when the box is emptied or the message is sent", () => {
    const store = memoryStorage();
    const key = draftKey("me", "conv-1");
    saveDraft(key, "half written", [], store);
    saveDraft(key, "   ", [], store);
    expect(store.map.size).toBe(0);
    saveDraft(key, "again", [], store);
    clearDraft(key, store);
    expect(loadDraft(key, store)).toBeNull();
  });

  it("drops mentions that were deleted from the text, old drafts and broken entries", () => {
    const store = memoryStorage();
    const key = draftKey("me", "conv-2");
    saveDraft(
      key,
      "no mention left",
      [{ label: "@Suez", token: "<@user:2>" }],
      store,
      0,
    );
    expect(loadDraft(key, store, 10)?.inserts).toEqual([]);
    expect(loadDraft(key, store, DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(store.map.has(key)).toBe(false);
    store.setItem(key, "{not json");
    expect(loadDraft(key, store)).toBeNull();
  });

  it("sign-out forgets every draft and nothing else", () => {
    const store = memoryStorage();
    saveDraft(draftKey("me", "a"), "one", [], store);
    saveDraft(draftKey("me", "b", "t"), "two", [], store);
    store.setItem("sp.install.dismissed", "1");
    forgetDrafts(store);
    expect([...store.map.keys()]).toEqual(["sp.install.dismissed"]);
  });
});
