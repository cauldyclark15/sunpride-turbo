"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { LiveClient, type LiveClientOptions } from "./live";
import { defaultApiStore, type ApiStore } from "./store";

type ApiContextValue = { store: ApiStore; live: LiveClient };

let defaultLive: LiveClient | undefined;
function getDefaultLive() {
  defaultLive ??= new LiveClient(defaultApiStore);
  return defaultLive;
}

const ApiContext = createContext<ApiContextValue | null>(null);

/**
 * Provides the keyed cache and the shared `/ws` connection. Without props it
 * uses the app-wide singletons (so `mutate()` called outside React hits the
 * same cache); tests pass their own store and fake socket factory.
 */
export function ApiProvider({
  children,
  store,
  live,
  liveOptions,
}: {
  children?: ReactNode;
  store?: ApiStore;
  live?: LiveClient;
  liveOptions?: LiveClientOptions;
}) {
  const [value] = useState<ApiContextValue>(() => {
    const resolvedStore = store ?? defaultApiStore;
    const resolvedLive =
      live ??
      (store || liveOptions
        ? new LiveClient(resolvedStore, liveOptions)
        : getDefaultLive());
    return { store: resolvedStore, live: resolvedLive };
  });
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (value) return value;
  return { store: defaultApiStore, live: getDefaultLive() };
}

export function useApiStore(): ApiStore {
  return useApiContext().store;
}

export function useLiveClient(): LiveClient {
  return useApiContext().live;
}
