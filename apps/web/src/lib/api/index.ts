/**
 * Web data layer (client side). Server components import `serverApi` from
 * `@/lib/api/server` instead. Usage guide: apps/web/docs/DATA_LAYER.md.
 */
export { ApiError, isApiError, normalizeError } from "./errors";
export type { NormalizedError } from "./errors";
export { apiFetch, buildApiUrl } from "./fetch";
export type { ApiFetchOptions } from "./fetch";
export { hashKey, keyMatches, normalizeKey } from "./key";
export type { ApiKey, ApiKeyInput } from "./key";
export { ApiStore, defaultApiStore } from "./store";
export type {
  Fetcher,
  FetchContext,
  QuerySnapshot,
  QueryStatus,
} from "./store";
export { LiveClient } from "./live";
export type { LiveSocket, LiveSocketFactory, LiveClientOptions } from "./live";
export { mutate } from "./mutate";
export type { MutateOptions } from "./mutate";
export { ApiProvider, useApiStore, useLiveClient } from "./provider";
export { useApi, useApiPages, useLive, useMutate } from "./hooks";
export type {
  ApiResult,
  ApiPagesResult,
  ApiPagesOptions,
  Page,
  PageFetcher,
  PagesStatus,
  MutateState,
} from "./hooks";
