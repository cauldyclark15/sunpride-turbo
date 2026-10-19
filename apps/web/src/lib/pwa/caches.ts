/**
 * Client side of the service-worker caches. Sign-out and a lost session call
 * {@link clearUserCaches}: it deletes the data and page caches directly
 * (CacheStorage is shared with the page) and also tells the worker, so the
 * next person on a shared phone sees no figures even offline.
 */

type CacheStorageLike = Pick<CacheStorage, "keys" | "delete">;

/** Same rule as `public/sw.js` `isUserCache`. */
export function isUserCacheName(name: string) {
  return name === "sp-data" || name.startsWith("sp-pages-");
}

export async function clearUserCaches(
  storage: CacheStorageLike | undefined = typeof caches === "undefined"
    ? undefined
    : caches,
  worker:
    Pick<ServiceWorker, "postMessage"> | null | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator.serviceWorker?.controller,
): Promise<string[]> {
  worker?.postMessage({ type: "CLEAR_USER_DATA" });
  if (!storage) return [];
  try {
    const names = (await storage.keys()).filter(isUserCacheName);
    await Promise.all(names.map((name) => storage.delete(name)));
    return names;
  } catch {
    return [];
  }
}
