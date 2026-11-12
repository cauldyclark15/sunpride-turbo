/**
 * Unsent messages kept on this device: one per conversation and one per thread,
 * for each signed-in person. Typing saves; sending, or emptying the box, removes it.
 * Sign-out removes them all ({@link forgetDrafts}), so the next person on a
 * shared computer never sees someone else's half-written message.
 */
import type { DraftInsert } from "./tokens";

export const DRAFT_PREFIX = "sp.msg.draft.v1:";
/** A draft nobody came back to for this long is dropped. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type StorageLike = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

export type StoredDraft = { text: string; inserts: DraftInsert[]; at: number };

function deviceStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function draftKey(
  meId: string,
  conversationId: string,
  parentId?: string | null,
) {
  return `${DRAFT_PREFIX}${meId}:${conversationId}${parentId ? `:${parentId}` : ""}`;
}

function isInsert(value: unknown): value is DraftInsert {
  const item = value as DraftInsert | null;
  return typeof item?.label === "string" && typeof item.token === "string";
}

export function loadDraft(
  key: string,
  store: StorageLike | undefined = deviceStorage(),
  now = Date.now(),
): StoredDraft | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredDraft>;
    const at = typeof value.at === "number" ? value.at : 0;
    if (
      typeof value.text !== "string" ||
      !value.text.trim() ||
      now - at > DRAFT_MAX_AGE_MS
    ) {
      store.removeItem(key);
      return null;
    }
    const text = value.text;
    const inserts = (Array.isArray(value.inserts) ? value.inserts : [])
      .filter(isInsert)
      .filter((item) => text.includes(item.label));
    return { text, inserts, at };
  } catch {
    return null;
  }
}

export function saveDraft(
  key: string,
  text: string,
  inserts: readonly DraftInsert[],
  store: StorageLike | undefined = deviceStorage(),
  now = Date.now(),
) {
  if (!store) return;
  try {
    if (!text.trim()) {
      store.removeItem(key);
      return;
    }
    const kept = inserts.filter((item) => text.includes(item.label));
    store.setItem(key, JSON.stringify({ text, inserts: kept, at: now }));
  } catch {
    // Storage full or blocked: the message still sends, it just isn't kept.
  }
}

export function clearDraft(
  key: string,
  store: StorageLike | undefined = deviceStorage(),
) {
  try {
    store?.removeItem(key);
  } catch {
    // ignore
  }
}

/** Removes every saved draft on this device (sign-out). */
export function forgetDrafts(store: StorageLike | undefined = deviceStorage()) {
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // ignore
  }
}
