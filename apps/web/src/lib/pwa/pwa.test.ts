import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "@/app/manifest";
import { phoneTabsFor, phoneTitleFor } from "@/config/phone-tabs";
import { getWebNavigation } from "@/config/navigation";
import { createAuthActions } from "@/lib/auth/client";
import {
  OFFLINE_SESSION_KEY,
  recallSession,
  rememberSession,
} from "@/lib/auth/offline-session";
import { canAccessWebModule } from "@/lib/module-access";
import { clearUserCaches, isUserCacheName } from "./caches";
import { cachedSince, noteDataSource, resetDataSource } from "./data-source";
import {
  INSTALL_QUIET_DAYS,
  installCardMode,
  isIosSafari,
  type InstallContext,
} from "./install";

const DAY = 24 * 60 * 60 * 1000;
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

afterEach(() => {
  vi.unstubAllGlobals();
  resetDataSource();
});

describe("web app manifest", () => {
  it("installs as Sunpride Operations, opening Today full screen", () => {
    const m = manifest();
    expect(m.name).toBe("Sunpride Operations");
    expect(m.short_name).toBe("Sunpride");
    expect(m.start_url).toBe("/today");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toBe("#ffffff");
    expect(m.background_color).toBe("#ffffff");
  });

  it("ships 192 and 512 icons, plain and maskable", () => {
    const icons = manifest().icons ?? [];
    for (const size of ["192x192", "512x512"])
      for (const purpose of ["any", "maskable"])
        expect(
          icons.some((icon) => icon.sizes === size && icon.purpose === purpose),
        ).toBe(true);
  });
});

describe("install card", () => {
  const base: InstallContext = {
    standalone: false,
    isPhone: true,
    signedIn: true,
    pathname: "/today",
    hasPrompt: true,
    userAgent: ANDROID,
    dismissedAt: null,
    now: Date.UTC(2026, 9, 19),
  };

  it("offers the browser prompt on an Android phone, on Today after sign-in", () => {
    expect(installCardMode(base)).toBe("prompt");
  });

  it("never shows once installed", () => {
    expect(installCardMode({ ...base, standalone: true })).toBeNull();
    expect(
      installCardMode({
        ...base,
        standalone: true,
        hasPrompt: false,
        userAgent: IPHONE,
      }),
    ).toBeNull();
  });

  it("shows the Share steps on iPhone Safari only", () => {
    const ios = { ...base, hasPrompt: false, userAgent: IPHONE };
    expect(installCardMode(ios)).toBe("ios");
    expect(isIosSafari(IPHONE_CHROME)).toBe(false);
    expect(installCardMode({ ...ios, userAgent: IPHONE_CHROME })).toBeNull();
    expect(installCardMode({ ...base, hasPrompt: false })).toBeNull();
  });

  it("stays quiet for 14 days after a dismiss", () => {
    expect(
      installCardMode({ ...base, dismissedAt: base.now - 3 * DAY }),
    ).toBeNull();
    expect(
      installCardMode({
        ...base,
        dismissedAt: base.now - (INSTALL_QUIET_DAYS * DAY - 1),
      }),
    ).toBeNull();
    expect(
      installCardMode({
        ...base,
        dismissedAt: base.now - INSTALL_QUIET_DAYS * DAY,
      }),
    ).toBe("prompt");
  });

  it("only on phones, signed in, on Today", () => {
    expect(installCardMode({ ...base, isPhone: false })).toBeNull();
    expect(installCardMode({ ...base, signedIn: false })).toBeNull();
    expect(installCardMode({ ...base, pathname: "/sales" })).toBeNull();
  });
});

describe("phone bottom tabs", () => {
  function tabsFor(role: string) {
    const nav = getWebNavigation("/today", (slug) =>
      canAccessWebModule(slug, role),
    );
    return phoneTabsFor(role, nav.navGroups);
  }

  it("gives the owner and managers Today, Sales, Coverage and Decide", () => {
    for (const role of ["super_admin", "admin", "manager"])
      expect(tabsFor(role).tabs.map((tab) => tab.id)).toEqual([
        "today",
        "sales",
        "coverage-people",
        "decide",
      ]);
  });

  it("picks each role's most used pages from what it can open", () => {
    expect(tabsFor("approver").tabs.map((t) => t.id)).toEqual([
      "today",
      "decide",
      "work",
      "sales",
    ]);
    expect(tabsFor("operations").tabs.map((t) => t.id)).toEqual([
      "today",
      "stock",
      "vans",
      "work",
    ]);
    for (const role of ["analyst", "viewer"])
      expect(tabsFor(role).tabs.map((t) => t.id)).toEqual([
        "today",
        "sales",
        "coverage-people",
        "stores",
      ]);
  });

  it("fills from the sidebar when a wish is not open to the role", () => {
    const { tabs } = tabsFor("sales");
    expect(tabs).toHaveLength(4);
    expect(tabs[0]!.id).toBe("today");
    for (const tab of tabs)
      expect(canAccessWebModule(tab.href.split("/")[1]!, "sales")).toBe(true);
  });

  it("puts every other sidebar page under More, none twice", () => {
    for (const role of ["admin", "approver", "operations", "viewer", "sales"]) {
      const nav = getWebNavigation("/today", (slug) =>
        canAccessWebModule(slug, role),
      );
      const all = nav.navGroups.flatMap((g) => g.items.map((i) => i.id));
      const { tabs, more } = phoneTabsFor(role, nav.navGroups);
      const ids = [...tabs, ...more].map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual([...all].sort());
    }
  });

  it("titles the top bar with the page name", () => {
    expect(phoneTitleFor("/today")).toBe("Today");
    expect(phoneTitleFor("/customers/customer")).toBe("Customers");
    expect(phoneTitleFor("/orders")).toBe("Orders");
    expect(phoneTitleFor("/account")).toBe("Account");
  });
});

function fakeCaches(names: string[]) {
  const live = new Set(names);
  return {
    live,
    keys: async () => [...live],
    delete: async (name: string) => live.delete(name),
  };
}

describe("sign-out clears the phone's caches", () => {
  it("deletes data and pages, keeps the app shell, and tells the worker", async () => {
    const storage = fakeCaches(["sp-data", "sp-pages-b1", "sp-static-b1"]);
    const worker = { postMessage: vi.fn() };
    const removed = await clearUserCaches(storage, worker);
    expect(removed.sort()).toEqual(["sp-data", "sp-pages-b1"]);
    expect([...storage.live]).toEqual(["sp-static-b1"]);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "CLEAR_USER_DATA",
    });
    expect(isUserCacheName("sp-static-b1")).toBe(false);
  });

  it("signOut empties the caches and forgets the offline session", async () => {
    const storage = fakeCaches(["sp-data", "sp-pages-b1", "sp-static-b1"]);
    const local = new Map<string, string>();
    vi.stubGlobal("caches", storage);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => local.get(k) ?? null,
        setItem: (k: string, v: string) => void local.set(k, v),
        removeItem: (k: string) => void local.delete(k),
      },
    });
    rememberSession({
      profile: {
        id: "p1",
        subject: "s1",
        name: "Ana",
        role: "admin",
        orgUnitId: null,
        active: true,
      },
      scope: null,
      permissions: ["report.read"],
    });
    expect(local.has(OFFLINE_SESSION_KEY)).toBe(true);
    noteDataSource(
      "/api/v1/analytics/today",
      new Headers({ "x-sp-from-cache": "1", "x-sp-cached-at": "5" }),
    );
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await createAuthActions(undefined, undefined, fetchImpl).signOut();
    expect([...storage.live]).toEqual(["sp-static-b1"]);
    expect(local.has(OFFLINE_SESSION_KEY)).toBe(false);
    expect(recallSession()).toBeNull();
    expect(cachedSince()).toBeNull();
  });
});

describe("offline figures banner source", () => {
  it("tracks the oldest cached answer until fresh ones replace it", () => {
    noteDataSource(
      "/a",
      new Headers({ "x-sp-from-cache": "1", "x-sp-cached-at": "200" }),
    );
    noteDataSource(
      "/b",
      new Headers({ "x-sp-from-cache": "1", "x-sp-cached-at": "100" }),
    );
    expect(cachedSince()).toBe(100);
    noteDataSource("/b", new Headers());
    expect(cachedSince()).toBe(200);
    noteDataSource("/a", new Headers());
    expect(cachedSince()).toBeNull();
  });

  it("ignores transports without headers", () => {
    noteDataSource("/a", undefined);
    expect(cachedSince()).toBeNull();
  });
});
