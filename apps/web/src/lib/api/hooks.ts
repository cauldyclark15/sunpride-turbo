"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ApiError } from "./errors";
import { normalizeError } from "./errors";
import { apiFetch } from "./fetch";
import {
  hashKey,
  normalizeKey,
  parseKeyHash,
  type ApiKey,
  type ApiKeyInput,
} from "./key";
import { mutate, type MutateOptions } from "./mutate";
import { useApiStore, useLiveClient } from "./provider";
import {
  IDLE_SNAPSHOT,
  type FetchContext,
  type Fetcher,
  type QuerySnapshot,
  type QueryStatus,
} from "./store";

export type ApiResult<T> = {
  /** `undefined` while loading or skipped; otherwise exactly what the server sent (`null`, `[]`, …). */
  data: T | undefined;
  error: ApiError | undefined;
  status: QueryStatus;
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => Promise<void>;
};

const noop = () => {};

function useKeyHash(input: ApiKeyInput) {
  const key = normalizeKey(input);
  return key === null ? null : hashKey(key);
}

function useStoreQuery<T>(hash: string | null, fetcher: Fetcher<T>) {
  const store = useApiStore();
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const subscribe = useCallback(
    (listener: () => void) =>
      hash === null
        ? noop
        : store.observe<T>(hash, () => fetcherRef.current, listener),
    [store, hash],
  );
  const getSnapshot = useCallback(
    (): QuerySnapshot<T> =>
      hash === null ? IDLE_SNAPSHOT : store.getSnapshot<T>(hash),
    [store, hash],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refetch = useCallback(
    () =>
      hash === null ? Promise.resolve() : store.fetch(hash, { force: true }),
    [store, hash],
  );
  return { store, snapshot, refetch };
}

/**
 * Keyed read. `key` identifies the data (include every filter and id);
 * a `null` key skips. `fetcher` is an API path (GET) or a function receiving
 * an AbortSignal. Equal keys share one cache entry and one in-flight request.
 *
 *   const board = useApi(["issues", "board", filters], (ctx) =>
 *     apiFetch("/api/v1/issues/board", { query: filters, signal: ctx.signal }));
 */
export function useApi<T>(
  key: ApiKeyInput,
  fetcher: string | Fetcher<T>,
): ApiResult<T> {
  const hash = useKeyHash(key);
  const resolved: Fetcher<T> =
    typeof fetcher === "string"
      ? ({ signal }: FetchContext<T>) => apiFetch<T>(fetcher, { signal })
      : fetcher;
  const { snapshot, refetch } = useStoreQuery<T>(hash, resolved);
  return {
    data: snapshot.data,
    error: snapshot.error,
    status: snapshot.status,
    isLoading: snapshot.status === "loading",
    isFetching: snapshot.isFetching,
    refetch,
  };
}

export type Page<T> = { items: readonly T[]; nextCursor: string | null };
export type PagesData<T> = { pages: Page<T>[]; truncated: boolean };
export type PageFetcher<T> = (
  cursor: string | null,
  context: { signal: AbortSignal },
) => Promise<Page<T>>;

export type PagesStatus =
  "idle" | "loading" | "loadingMore" | "canLoadMore" | "exhausted" | "error";

export type ApiPagesResult<T> = {
  /** All loaded items in page order; `undefined` until the first page. */
  items: T[] | undefined;
  pages: Page<T>[] | undefined;
  status: PagesStatus;
  error: ApiError | undefined;
  /** Every page is loaded (no continuation cursor left, nothing truncated). */
  isComplete: boolean;
  /** `all` mode stopped at `maxPages` with more pages left. */
  truncated: boolean;
  loadMore: () => Promise<void>;
  reset: () => Promise<void>;
  refetch: () => Promise<void>;
};

export type ApiPagesOptions = {
  /** Keep fetching until the cursor runs out (complete aggregates). */
  all?: boolean;
  /** Safety bound for `all` (default 50 pages). */
  maxPages?: number;
};

async function loadPages<T>(
  fetchPage: PageFetcher<T>,
  count: number,
  signal: AbortSignal,
): Promise<PagesData<T>> {
  const pages: Page<T>[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const page: Page<T> = await fetchPage(cursor, { signal });
    pages.push(page);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return { pages, truncated: false };
}

/**
 * Cursor pagination over one cache key. A refetch (invalidate, reconnect)
 * reloads as many pages as are on screen; `all` loads every page and keeps
 * `isComplete`/`truncated` honest instead of treating page one as the total.
 */
export function useApiPages<T>(
  key: ApiKeyInput,
  fetchPage: PageFetcher<T>,
  options: ApiPagesOptions = {},
): ApiPagesResult<T> {
  const hash = useKeyHash(key);
  const all = options.all ?? false;
  const maxPages = options.maxPages ?? 50;
  const pageRef = useRef(fetchPage);
  useEffect(() => {
    pageRef.current = fetchPage;
  });
  const fetcher: Fetcher<PagesData<T>> = async ({ signal, previous }) => {
    const count = all ? maxPages : Math.max(1, previous?.pages.length ?? 1);
    const data = await loadPages(pageRef.current, count, signal);
    const last = data.pages.at(-1);
    return { ...data, truncated: all && Boolean(last?.nextCursor) };
  };
  const { store, snapshot, refetch } = useStoreQuery<PagesData<T>>(
    hash,
    fetcher,
  );
  const data = snapshot.data;
  const items = useMemo(
    () => data?.pages.flatMap((page) => [...page.items]),
    [data],
  );
  const loadMore = useCallback(async () => {
    if (hash === null) return;
    await store.fetch(hash, {
      force: true,
      fetcher: async ({ signal, previous }) => {
        const prior = previous as PagesData<T> | undefined;
        const cursor = prior?.pages.at(-1)?.nextCursor;
        if (!prior) return loadPages(pageRef.current, 1, signal);
        if (!cursor) return prior;
        const page = await pageRef.current(cursor, { signal });
        return { pages: [...prior.pages, page], truncated: false };
      },
    });
  }, [store, hash]);
  const reset = useCallback(async () => {
    if (hash === null) return;
    await store.fetch(hash, {
      force: true,
      fetcher: ({ signal }) => loadPages(pageRef.current, 1, signal),
    });
  }, [store, hash]);

  const hasMore = Boolean(data?.pages.at(-1)?.nextCursor);
  const status: PagesStatus =
    snapshot.status === "idle"
      ? "idle"
      : snapshot.status === "error"
        ? "error"
        : data === undefined
          ? "loading"
          : snapshot.isFetching
            ? "loadingMore"
            : hasMore
              ? "canLoadMore"
              : "exhausted";
  return {
    items,
    pages: data?.pages,
    status,
    error: snapshot.error,
    isComplete: data !== undefined && !hasMore && !data.truncated,
    truncated: data?.truncated ?? false,
    loadMore,
    reset,
    refetch,
  };
}

/**
 * Keeps `keys` fresh while mounted: subscribes `topics` on the shared `/ws`
 * connection and refetches (coalesced) when the server invalidates one.
 *
 *   useLive(["issues"], [["issues"]]);            // every issues key
 *   useLive([`issue:${n}`], [["issue", n]]);
 */
export function useLive(
  topics: string | readonly string[] | null,
  keys: readonly ApiKeyInput[],
) {
  const live = useLiveClient();
  const topicList =
    topics === null ? [] : typeof topics === "string" ? [topics] : topics;
  const topicsHash = JSON.stringify([...topicList].sort());
  const keysHash = hashKey(
    keys.map(normalizeKey).filter((key): key is ApiKey => key !== null),
  );
  useEffect(() => {
    const parsedTopics = JSON.parse(topicsHash) as string[];
    const parsedKeys = parseKeyHash(keysHash) as ApiKey[];
    if (!parsedTopics.length || !parsedKeys.length) return;
    return live.register(parsedTopics, parsedKeys);
  }, [live, topicsHash, keysHash]);
}

export type MutateState = {
  mutate: <T = unknown>(
    path: string,
    body?: unknown,
    options?: Omit<MutateOptions, "store">,
  ) => Promise<T>;
  pending: boolean;
  error: ApiError | undefined;
  reset: () => void;
};

/** `mutate` bound to the provider's store, with pending/error state for forms. */
export function useMutate(): MutateState {
  const store = useApiStore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const run = useCallback(
    async <T>(
      path: string,
      body?: unknown,
      options: Omit<MutateOptions, "store"> = {},
    ) => {
      setPending(true);
      setError(undefined);
      try {
        return await mutate<T>(path, body, { ...options, store });
      } catch (raw) {
        const normalized = normalizeError(raw);
        setError(normalized);
        throw normalized;
      } finally {
        setPending(false);
      }
    },
    [store],
  );
  const reset = useCallback(() => setError(undefined), []);
  return { mutate: run, pending, error, reset };
}
