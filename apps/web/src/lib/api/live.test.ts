import { describe, expect, it, vi } from "vitest";
import { hashKey } from "./key";
import { LiveClient, type LiveSocket } from "./live";
import { ApiStore } from "./store";

class FakeSocket implements LiveSocket {
  readyState = 0;
  sent: unknown[] = [];
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  // Server side of the fake:
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function setup() {
  let clock = 1_000;
  const now = () => clock;
  const store = new ApiStore({ coalesceMs: 10, now });
  const sockets: FakeSocket[] = [];
  const live = new LiveClient(store, {
    url: () => "ws://test/ws",
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    reconnectMinMs: 100,
    now,
  });
  const advanceClock = (ms: number) => {
    clock += ms;
  };
  return { store, live, sockets, advanceClock };
}

describe("useLive realtime client", () => {
  it("shares one socket, subscribes topics, and refetches on invalidate", async () => {
    vi.useFakeTimers();
    try {
      const { store, live, sockets, advanceClock } = setup();
      const board = vi.fn(async () => ["issue"]);
      const detail = vi.fn(async () => ({ id: 142 }));
      store.observe(
        hashKey(["issues", "board"]),
        () => board,
        () => {},
      );
      store.observe(
        hashKey(["issue", 142]),
        () => detail,
        () => {},
      );
      await vi.advanceTimersByTimeAsync(0);
      advanceClock(5);

      live.register(["issues"], [["issues"]]);
      live.register(["issue:142"], [["issue", 142]]);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.url).toBe("ws://test/ws");

      sockets[0]!.open();
      expect(sockets[0]!.sent).toEqual([
        { type: "subscribe", topics: ["issues", "issue:142"] },
      ]);
      // Data fetched before the subscription is resynced once.
      await vi.advanceTimersByTimeAsync(15);
      expect(board).toHaveBeenCalledTimes(2);
      expect(detail).toHaveBeenCalledTimes(2);

      sockets[0]!.push({ type: "invalidate", topic: "issues", seq: 7 });
      sockets[0]!.push({ type: "invalidate", topic: "issues", seq: 8 });
      await vi.advanceTimersByTimeAsync(15);
      expect(board).toHaveBeenCalledTimes(3); // coalesced
      expect(detail).toHaveBeenCalledTimes(2); // other topic untouched

      // A topic registered later is added on the open socket.
      live.register(["orders"], [["orders"]]);
      expect(sockets[0]!.sent.at(-1)).toEqual({
        type: "subscribe",
        topics: ["orders"],
      });
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects after a drop, resubscribes and resyncs every key", async () => {
    vi.useFakeTimers();
    try {
      const { store, live, sockets, advanceClock } = setup();
      const board = vi.fn(async () => ["issue"]);
      store.observe(
        hashKey(["issues"]),
        () => board,
        () => {},
      );
      live.register(["issues"], [["issues"]]);
      await vi.advanceTimersByTimeAsync(0);
      sockets[0]!.open();
      await vi.advanceTimersByTimeAsync(15);
      const callsBeforeDrop = board.mock.calls.length;

      advanceClock(1_000);
      sockets[0]!.drop();
      await vi.advanceTimersByTimeAsync(99);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);

      advanceClock(1_000);
      sockets[1]!.open();
      expect(sockets[1]!.sent).toEqual([
        { type: "subscribe", topics: ["issues"] },
      ]);
      await vi.advanceTimersByTimeAsync(15);
      expect(board).toHaveBeenCalledTimes(callsBeforeDrop + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes when the last reader leaves and ignores the old socket", async () => {
    vi.useFakeTimers();
    try {
      const { live, sockets } = setup();
      const stop = live.register(["issues"], [["issues"]]);
      sockets[0]!.open();
      stop();
      expect(sockets[0]!.readyState).toBe(3);
      sockets[0]!.drop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(1);
      expect(live.subscribedTopics()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
