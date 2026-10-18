import { ApiError, isAbortError, normalizeError } from "./errors";
import { hashKey, keyMatches, parseKeyHash, type ApiKey } from "./key";

export type QueryStatus = "idle" | "loading" | "success" | "error";

/**
 * What a reader sees for one key. `data` is `undefined` until the first
 * response (loading or skipped); `null` and `[]` are real answers and are
 * kept exactly as the server sent them.
 */
export type QuerySnapshot<T> = {
  readonly data: T | undefined;
  readonly error: ApiError | undefined;
  readonly status: QueryStatus;
  /** True while any request (first load or refetch) is in flight. */
  readonly isFetching: boolean;
};

export type FetchContext<T> = {
  signal: AbortSignal;
  /** The data currently cached for this key (for incremental fetchers). */
  previous: T | undefined;
};

export type Fetcher<T> = (context: FetchContext<T>) => Promise<T>;

export const IDLE_SNAPSHOT: QuerySnapshot<never> = Object.freeze({
  data: undefined,
  error: undefined,
  status: "idle",
  isFetching: false,
});

const LOADING_SNAPSHOT: QuerySnapshot<never> = Object.freeze({
  data: undefined,
  error: undefined,
  status: "loading",
  isFetching: false,
});

type Entry = {
  key: ApiKey;
  snapshot: QuerySnapshot<unknown>;
  listeners: Set<() => void>;
  fetcher: (() => Fetcher<unknown>) | undefined;
  /** Bumped by every fetch; a response is applied only if it still matches. */
  generation: number;
  inFlight:
    | {
        generation: number;
        controller: AbortController;
        promise: Promise<void>;
      }
    | undefined;
  /** Needs a fresh fetch before its data can be trusted again. */
  stale: boolean;
  /** When the request whose data is cached started (ms since epoch). */
  fetchStartedAt: number;
  gcTimer: ReturnType<typeof setTimeout> | undefined;
};

export type ApiStoreOptions = {
  /** Invalidations within this window collapse into one refetch per key. */
  coalesceMs?: number;
  /** How long unobserved data stays cached. */
  gcMs?: number;
  now?: () => number;
};

export type InvalidateOptions = {
  /** Only entries whose cached request started before this instant. */
  olderThan?: number;
  /** Refetch now instead of after the coalescing window. */
  immediate?: boolean;
};

/**
 * Transport-neutral keyed cache behind useApi/useApiPages/useLive/mutate.
 * Framework-free so it is unit-testable without a DOM; the hooks are thin
 * `useSyncExternalStore` bindings over it.
 */
export class ApiStore {
  private entries = new Map<string, Entry>();
  private pendingRefetch = new Set<string>();
  private refetchTimer: ReturnType<typeof setTimeout> | undefined;
  private errorListeners = new Set<(error: ApiError, key: ApiKey) => void>();
  /** Identity epoch: bumped by clear(); older responses are discarded. */
  private epochValue = 0;
  private readonly coalesceMs: number;
  private readonly gcMs: number;
  private readonly now: () => number;

  constructor(options: ApiStoreOptions = {}) {
    this.coalesceMs = options.coalesceMs ?? 30;
    this.gcMs = options.gcMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  get epoch() {
    return this.epochValue;
  }

  getSnapshot<T>(hash: string): QuerySnapshot<T> {
    return (this.entries.get(hash)?.snapshot ??
      LOADING_SNAPSHOT) as QuerySnapshot<T>;
  }

  /**
   * Registers a reader. Starts a fetch unless fresh data or an equal
   * request is already there (dedupe). Returns the unsubscribe function.
   */
  observe<T>(
    hash: string,
    getFetcher: () => Fetcher<T>,
    listener: () => void,
  ): () => void {
    const entry = this.ensure(hash);
    entry.fetcher = getFetcher as () => Fetcher<unknown>;
    entry.listeners.add(listener);
    if (entry.gcTimer) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = undefined;
    }
    if (!entry.inFlight && (entry.stale || entry.snapshot.status === "loading"))
      void this.fetch(hash);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0 && this.entries.get(hash) === entry)
        entry.gcTimer = setTimeout(() => {
          if (entry.listeners.size === 0 && this.entries.get(hash) === entry) {
            entry.inFlight?.controller.abort();
            this.entries.delete(hash);
          }
        }, this.gcMs);
    };
  }

  /**
   * Fetches a key. Without `force`, joins an in-flight request (dedupe).
   * With `force`, supersedes it: the older response is aborted and, if it
   * still arrives, rejected as stale. `fetcher` overrides the registered one
   * for this run (useApiPages' loadMore).
   */
  fetch(
    hash: string,
    options: { force?: boolean; fetcher?: Fetcher<unknown> } = {},
  ): Promise<void> {
    const entry = this.ensure(hash);
    if (entry.inFlight && !options.force) return entry.inFlight.promise;
    const fetcher = options.fetcher ?? entry.fetcher?.();
    if (!fetcher) return Promise.resolve();

    entry.inFlight?.controller.abort();
    const generation = ++entry.generation;
    const epoch = this.epochValue;
    const controller = new AbortController();
    const startedAt = this.now();
    this.setSnapshot(entry, { ...entry.snapshot, isFetching: true });

    const current = () =>
      this.entries.get(hash) === entry &&
      entry.generation === generation &&
      this.epochValue === epoch;

    const promise = (async () => {
      try {
        const data = await fetcher({
          signal: controller.signal,
          previous: entry.snapshot.data,
        });
        if (!current()) return;
        entry.stale = false;
        entry.fetchStartedAt = startedAt;
        this.setSnapshot(entry, {
          data,
          error: undefined,
          status: "success",
          isFetching: false,
        });
      } catch (raw) {
        if (!current() || (isAbortError(raw) && controller.signal.aborted))
          return;
        const error = normalizeError(raw);
        entry.stale = false;
        this.setSnapshot(entry, {
          data: entry.snapshot.data,
          error,
          status: "error",
          isFetching: false,
        });
        for (const listener of this.errorListeners) listener(error, entry.key);
      } finally {
        if (entry.inFlight?.generation === generation)
          entry.inFlight = undefined;
      }
    })();
    entry.inFlight = { generation, controller, promise };
    return promise;
  }

  /**
   * Marks every key matching one of `patterns` (prefix match) stale.
   * Observed keys refetch once after the coalescing window; unobserved ones
   * are dropped so the next reader fetches fresh.
   */
  invalidate(
    patterns: readonly ApiKey[] | ((key: ApiKey) => boolean),
    options: InvalidateOptions = {},
  ) {
    const matches =
      typeof patterns === "function"
        ? patterns
        : (key: ApiKey) => patterns.some((pattern) => keyMatches(key, pattern));
    for (const [hash, entry] of this.entries) {
      if (!matches(entry.key)) continue;
      if (
        options.olderThan !== undefined &&
        !entry.inFlight &&
        entry.fetchStartedAt >= options.olderThan
      )
        continue;
      if (entry.listeners.size === 0) {
        entry.inFlight?.controller.abort();
        this.entries.delete(hash);
        continue;
      }
      entry.stale = true;
      this.pendingRefetch.add(hash);
    }
    if (options.immediate) this.flush();
    else this.scheduleFlush();
  }

  /** Runs pending coalesced refetches now (tests, and immediate invalidations). */
  flush() {
    if (this.refetchTimer) {
      clearTimeout(this.refetchTimer);
      this.refetchTimer = undefined;
    }
    const hashes = [...this.pendingRefetch];
    this.pendingRefetch.clear();
    return Promise.all(
      hashes
        .filter((hash) => this.entries.get(hash)?.stale)
        .map((hash) => this.fetch(hash, { force: true })),
    ).then(() => undefined);
  }

  /** Writes data for a key directly (seeding, optimistic UI is not supported). */
  setData<T>(key: ApiKey, data: T) {
    const entry = this.ensure(hashKey(key));
    entry.stale = false;
    entry.fetchStartedAt = this.now();
    this.setSnapshot(entry, {
      data,
      error: undefined,
      status: "success",
      isFetching: false,
    });
  }

  /**
   * Identity change (sign-in, sign-out, another account): bumps the epoch so
   * every in-flight response is discarded, drops all cached data, and
   * reloads what is still on screen from scratch.
   */
  clear(options: { keep?: readonly ApiKey[] } = {}) {
    this.epochValue += 1;
    const keep = options.keep ?? [];
    for (const [hash, entry] of this.entries) {
      if (keep.some((pattern) => keyMatches(entry.key, pattern))) continue;
      entry.inFlight?.controller.abort();
      entry.inFlight = undefined;
      entry.generation += 1;
      if (entry.listeners.size === 0) {
        if (entry.gcTimer) clearTimeout(entry.gcTimer);
        this.entries.delete(hash);
        continue;
      }
      entry.stale = true;
      this.setSnapshot(entry, LOADING_SNAPSHOT);
      this.pendingRefetch.add(hash);
    }
    return this.flush();
  }

  /** Called with every fetch error (the session provider watches for 401). */
  onError(listener: (error: ApiError, key: ApiKey) => void) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /** Keys currently cached (diagnostics and tests). */
  keys(): ApiKey[] {
    return [...this.entries.values()].map((entry) => entry.key);
  }

  private ensure(hash: string): Entry {
    let entry = this.entries.get(hash);
    if (!entry) {
      entry = {
        key: parseKeyHash(hash),
        snapshot: LOADING_SNAPSHOT,
        listeners: new Set(),
        fetcher: undefined,
        generation: 0,
        inFlight: undefined,
        stale: false,
        fetchStartedAt: 0,
        gcTimer: undefined,
      };
      this.entries.set(hash, entry);
    }
    return entry;
  }

  private setSnapshot(entry: Entry, snapshot: QuerySnapshot<unknown>) {
    entry.snapshot = Object.freeze({ ...snapshot });
    for (const listener of [...entry.listeners]) listener();
  }

  private scheduleFlush() {
    if (this.refetchTimer || this.pendingRefetch.size === 0) return;
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = undefined;
      void this.flush();
    }, this.coalesceMs);
  }
}

/** The app-wide store; ApiProvider uses it unless handed another one. */
export const defaultApiStore = new ApiStore();
