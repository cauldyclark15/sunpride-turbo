/**
 * Which figures on screen came from the service-worker cache. `apiFetch`
 * reports every GET answer here; the offline banner shows the oldest cached
 * time until fresh answers replace them.
 */

type Listener = () => void;

const cachedPaths = new Map<string, number>();
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

/** Records whether `path` was answered from the cache (`x-sp-from-cache`). */
export function noteDataSource(
  path: string,
  headers: Pick<Headers, "get"> | undefined,
) {
  if (typeof headers?.get !== "function") return;
  const fromCache = headers.get("x-sp-from-cache") === "1";
  if (fromCache) {
    const at = Number(headers.get("x-sp-cached-at"));
    const when = Number.isFinite(at) && at > 0 ? at : Date.now();
    if (cachedPaths.get(path) === when) return;
    cachedPaths.set(path, when);
    emit();
  } else if (cachedPaths.delete(path)) emit();
}

/** Oldest cached-at time among figures on screen, or null when all are live. */
export function cachedSince(): number | null {
  let oldest: number | null = null;
  for (const at of cachedPaths.values())
    if (oldest === null || at < oldest) oldest = at;
  return oldest;
}

export function resetDataSource() {
  if (!cachedPaths.size) return;
  cachedPaths.clear();
  emit();
}

export function subscribeDataSource(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
