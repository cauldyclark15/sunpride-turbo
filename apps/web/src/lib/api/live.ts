import { hashKey, type ApiKey } from "./key";
import type { ApiStore } from "./store";

/** The subset of the browser WebSocket the live client uses (fakeable). */
export type LiveSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type LiveSocketFactory = (url: string) => LiveSocket;

export type LiveClientOptions = {
  /** Defaults to `ws(s)://<current host>/ws`. */
  url?: () => string;
  /** Defaults to the browser WebSocket. */
  createSocket?: LiveSocketFactory;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  now?: () => number;
};

type Registration = { topics: readonly string[]; keys: readonly ApiKey[] };

const OPEN = 1;

/**
 * One shared `/ws` connection per app (BACKEND_V2 §4). Components register
 * `(topics, keys)`; the server sends invalidation-only messages
 * (`{"type":"invalidate","topic","seq"}`) and the matching keys refetch
 * through the store's coalescing window. Data never travels over the socket.
 * A (re)connect resubscribes every topic and resyncs every key whose data was
 * fetched before the subscription, so a commit between fetch and subscribe
 * (or during an outage) is never missed.
 */
export class LiveClient {
  private socket: LiveSocket | undefined;
  private registrations = new Map<number, Registration>();
  private nextId = 1;
  private subscribed = new Set<string>();
  private lastSeq = new Map<string, number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private closedByClient = false;
  private readonly options: Required<
    Omit<LiveClientOptions, "url" | "createSocket">
  > &
    Pick<LiveClientOptions, "url" | "createSocket">;

  constructor(
    private readonly store: ApiStore,
    options: LiveClientOptions = {},
  ) {
    this.options = {
      reconnectMinMs: options.reconnectMinMs ?? 500,
      reconnectMaxMs: options.reconnectMaxMs ?? 15_000,
      now: options.now ?? Date.now,
      url: options.url,
      createSocket: options.createSocket,
    };
  }

  /** Subscribes `topics`; an invalidation on any of them invalidates `keys`. */
  register(topics: readonly string[], keys: readonly ApiKey[]): () => void {
    const id = this.nextId++;
    this.registrations.set(id, { topics: [...topics], keys: [...keys] });
    this.connectOrSubscribe();
    return () => {
      this.registrations.delete(id);
      if (this.registrations.size === 0) this.disconnect();
    };
  }

  /** Identity changed: drop the socket and reconnect with the new cookie. */
  reset() {
    this.disconnect();
    if (this.registrations.size > 0) this.connectOrSubscribe();
  }

  /** Topics currently subscribed on the open socket (tests/diagnostics). */
  subscribedTopics() {
    return [...this.subscribed].sort();
  }

  private topics() {
    const all = new Set<string>();
    for (const registration of this.registrations.values())
      for (const topic of registration.topics) all.add(topic);
    return all;
  }

  private connectOrSubscribe() {
    if (this.socket?.readyState === OPEN) {
      const fresh = [...this.topics()].filter((t) => !this.subscribed.has(t));
      if (fresh.length) this.subscribe(fresh);
      return;
    }
    if (this.socket || this.reconnectTimer) return;
    this.open();
  }

  private open() {
    const createSocket =
      this.options.createSocket ??
      (typeof WebSocket === "undefined"
        ? undefined
        : (url: string) => new WebSocket(url) as unknown as LiveSocket);
    const url = this.options.url?.() ?? defaultLiveUrl();
    if (!createSocket || !url) return;
    this.closedByClient = false;
    const socket = createSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      const openedAt = this.options.now();
      this.subscribed.clear();
      this.subscribe([...this.topics()]);
      // Resync: anything fetched before this subscription may have missed an
      // invalidation (first connect race, or an outage on reconnect).
      this.store.invalidate(this.allKeys(), { olderThan: openedAt });
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.subscribed.clear();
      if (!this.closedByClient && this.registrations.size > 0)
        this.scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose follows and handles reconnecting.
    };
  }

  private subscribe(topics: string[]) {
    if (!topics.length || this.socket?.readyState !== OPEN) return;
    for (const topic of topics) this.subscribed.add(topic);
    this.socket.send(JSON.stringify({ type: "subscribe", topics }));
  }

  private receive(raw: unknown) {
    let message: unknown;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const { type, topic, seq } = message as Record<string, unknown>;
    if (type === "resync") {
      this.store.invalidate(this.allKeys());
      return;
    }
    if (type !== "invalidate" || typeof topic !== "string") return;
    if (typeof seq === "number") {
      const last = this.lastSeq.get(topic);
      if (last !== undefined && seq <= last) return; // duplicate delivery
      this.lastSeq.set(topic, seq);
    }
    const keys: ApiKey[] = [];
    for (const registration of this.registrations.values())
      if (registration.topics.includes(topic)) keys.push(...registration.keys);
    if (keys.length) this.store.invalidate(dedupeKeys(keys));
  }

  private allKeys() {
    const keys: ApiKey[] = [];
    for (const registration of this.registrations.values())
      keys.push(...registration.keys);
    return dedupeKeys(keys);
  }

  private scheduleReconnect() {
    const delay = Math.min(
      this.options.reconnectMaxMs,
      this.options.reconnectMinMs * 2 ** this.attempts,
    );
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.registrations.size > 0 && !this.socket) this.open();
    }, delay);
  }

  private disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.attempts = 0;
    this.subscribed.clear();
    this.lastSeq.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      this.closedByClient = true;
      socket.close(1000, "client");
    }
  }
}

function dedupeKeys(keys: ApiKey[]) {
  const seen = new Map<string, ApiKey>();
  for (const key of keys) seen.set(hashKey(key), key);
  return [...seen.values()];
}

function defaultLiveUrl() {
  if (typeof location === "undefined") return "";
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}
