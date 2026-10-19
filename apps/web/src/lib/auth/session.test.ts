import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { hashKey } from "../api/key";
import { LiveClient } from "../api/live";
import { ApiProvider } from "../api/provider";
import { ApiStore } from "../api/store";
import { createAuthActions, fetchMe, SESSION_KEY } from "./client";
import {
  deriveSessionStatus,
  SessionProvider,
  usePermissions,
  useSession,
  type SessionValue,
} from "./session";
import type { Me } from "./types";

const ME: Me = {
  profile: {
    id: "p1",
    subject: "u1",
    name: "Ana Reyes",
    role: "manager",
    orgUnitId: "unit-1",
    active: true,
  },
  scope: null,
  permissions: ["issue.read", "mcp.approve"],
};

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? "" : JSON.stringify(body), { status });

function renderSession(store: ApiStore) {
  const captured: { session?: SessionValue; can?: boolean } = {};
  function Probe() {
    captured.session = useSession();
    const permissions = usePermissions();
    captured.can = permissions.can("mcp.approve");
    return createElement(
      "p",
      null,
      `${captured.session.status}:${captured.session.profile?.name ?? "-"}:${permissions.role ?? "-"}`,
    );
  }
  const live = new LiveClient(store, {
    createSocket: undefined,
    url: () => "",
  });
  const markup = renderToStaticMarkup(
    createElement(
      ApiProvider,
      { store, live },
      createElement(SessionProvider, null, createElement(Probe)),
    ),
  );
  return { markup, captured };
}

describe("SessionProvider", () => {
  it("exposes the /api/me profile and permissions", () => {
    const store = new ApiStore();
    store.setData(SESSION_KEY, ME);
    const { markup, captured } = renderSession(store);
    expect(markup).toBe("<p>authenticated:Ana Reyes:manager</p>");
    expect(captured.can).toBe(true);
  });

  it("is loading until /api/me answers, and signed out on null", () => {
    const store = new ApiStore();
    expect(renderSession(store).markup).toBe("<p>loading:-:-</p>");
    store.setData(SESSION_KEY, null);
    expect(renderSession(store).markup).toBe("<p>unauthenticated:-:-</p>");
  });

  it("clears every cached key on sign-out, even when the call fails", async () => {
    const store = new ApiStore();
    store.setData(SESSION_KEY, ME);
    store.setData(["issues", "board"], ["secret issue"]);
    store.setData(["orders"], []);
    const fetchMock = vi.fn(async () => {
      throw new TypeError("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { captured } = renderSession(store);
      const epoch = store.epoch;
      await captured.session!.signOut();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/sign-out",
        expect.objectContaining({ method: "POST" }),
      );
      expect(store.keys()).toEqual([]);
      expect(store.epoch).toBe(epoch + 1);
      expect(
        store.getSnapshot(hashKey(["issues", "board"])).data,
      ).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("auth actions", () => {
  it("returns a server refusal as error and keeps the cache", async () => {
    const store = new ApiStore();
    store.setData(["orders"], ["kept"]);
    const actions = createAuthActions(store, undefined, async () =>
      json(401, {
        error: {
          code: "invalid_credentials",
          message: "Wrong email or password.",
          retryable: false,
        },
      }),
    );
    const result = await actions.signIn({ email: "a@b.c", password: "x" });
    expect(result.error?.message).toBe("Wrong email or password.");
    expect(store.keys()).toHaveLength(1);
  });

  it("clears the cache after a successful sign-in", async () => {
    const store = new ApiStore();
    store.setData(["orders"], ["other account"]);
    const actions = createAuthActions(store, undefined, async () =>
      json(200, { ok: true }),
    );
    expect(
      (await actions.signIn({ email: "a@b.c", password: "x" })).error,
    ).toBeNull();
    expect(store.keys()).toEqual([]);
  });

  it("adapts CORE's real web profile and capabilities without turning off active people", async () => {
    const result = await fetchMe(undefined, async () =>
      json(200, {
        user: { id: "u1", email: "ana@example.com" },
        profile: {
          id: "p1",
          name: "Ana",
          role: "manager",
          orgUnitId: "unit",
          status: "active",
        },
        capabilities: ["report.read"],
      }),
    );
    expect(result?.profile).toMatchObject({
      subject: "u1",
      active: true,
      name: "Ana",
    });
    expect(result?.permissions).toEqual(["report.read"]);
  });
  it("does not activate disabled or missing web profiles", async () => {
    const result = await fetchMe(undefined, async () =>
      json(200, {
        user: { id: "u1", email: "ana@example.com" },
        profile: {
          id: "p1",
          name: "Ana",
          role: "manager",
          orgUnitId: "unit",
          status: "disabled",
        },
        capabilities: [],
      }),
    );
    expect(result?.profile.active).toBe(false);
    await expect(
      fetchMe(undefined, async () =>
        json(200, {
          user: { id: "u1", email: "ana@example.com" },
          profile: null,
          capabilities: [],
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "not_invited" });
  });
  it("fetchMe maps 401 to null and other failures to errors", async () => {
    expect(
      await fetchMe(undefined, async () => json(401, undefined)),
    ).toBeNull();
    await expect(
      fetchMe(undefined, async () =>
        json(403, { error: { code: "not_invited", message: "Not invited" } }),
      ),
    ).rejects.toMatchObject({ code: "not_invited", status: 403 });
  });

  it("derives refused/error/authenticated statuses", () => {
    const refused = { status: 403, code: "not_invited" } as never;
    expect(
      deriveSessionStatus({ status: "error", data: undefined, error: refused }),
    ).toBe("refused");
    const down = { status: 0, code: "network_error" } as never;
    expect(
      deriveSessionStatus({ status: "error", data: undefined, error: down }),
    ).toBe("error");
    expect(
      deriveSessionStatus({ status: "error", data: ME, error: down }),
    ).toBe("authenticated");
  });
});
