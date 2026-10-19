"use client";

/**
 * Browser-side PWA state: the service-worker registration (production builds
 * only), a waiting update, and the kept `beforeinstallprompt` event.
 */

export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type State = {
  waiting: ServiceWorker | null;
  installPrompt: InstallPromptEvent | null;
  installed: boolean;
};

const state: State = { waiting: null, installPrompt: null, installed: false };
const listeners = new Set<() => void>();
let snapshot: State = { ...state };

function emit() {
  snapshot = { ...state };
  for (const listener of listeners) listener();
}

export function subscribePwa(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pwaSnapshot() {
  return snapshot;
}

const SERVER_SNAPSHOT: State = {
  waiting: null,
  installPrompt: null,
  installed: false,
};
export function pwaServerSnapshot() {
  return SERVER_SNAPSHOT;
}

/** Only production builds run the worker; development keeps hot reload honest. */
export function serviceWorkerEnabled() {
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- NODE_ENV is set by Next itself.
  return process.env.NODE_ENV === "production";
}

export function serviceWorkerUrl() {
  // Inlined at build time by next.config `env`.
  const build = process.env.NEXT_PUBLIC_SP_BUILD_ID ?? "local";
  return `/sw.js?v=${encodeURIComponent(build)}`;
}

let started = false;

export function startPwa() {
  if (started || typeof window === "undefined") return;
  started = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    state.installed = true;
    emit();
  });

  if (!serviceWorkerEnabled() || !("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;
  let reloading = false;
  container.addEventListener("controllerchange", () => {
    // Only a deliberate "Reload" swaps workers; the first install claims silently.
    if (!reloading && state.waiting) {
      reloading = true;
      window.location.reload();
    }
  });

  const register = async () => {
    try {
      const registration = await container.register(serviceWorkerUrl(), {
        scope: "/",
        updateViaCache: "none",
      });
      const track = (worker: ServiceWorker | null) => {
        if (!worker) return;
        const check = () => {
          if (worker.state === "installed" && container.controller) {
            state.waiting = worker;
            emit();
          }
        };
        check();
        worker.addEventListener("statechange", check);
      };
      track(registration.waiting);
      registration.addEventListener("updatefound", () =>
        track(registration.installing),
      );
      await container.ready;
      warmStaticAssets();
    } catch {
      // No worker: the app still works online.
    }
  };
  if (document.readyState === "complete") void register();
  else window.addEventListener("load", () => void register(), { once: true });
}

/** Sends the hashed chunks this page already loaded to the worker's static cache. */
function warmStaticAssets() {
  const worker = navigator.serviceWorker.controller;
  if (!worker || typeof performance === "undefined") return;
  const urls = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((url) => url.includes("/_next/static/"));
  if (urls.length) worker.postMessage({ type: "WARM", urls });
}

/** "A new version is ready · Reload". */
export function applyUpdate() {
  const worker = state.waiting;
  if (!worker) return;
  worker.postMessage({ type: "SKIP_WAITING" });
}

export async function promptInstall() {
  const event = state.installPrompt;
  if (!event) return "unavailable" as const;
  await event.prompt();
  const choice = await event.userChoice.catch(() => ({
    outcome: "dismissed" as const,
  }));
  state.installPrompt = null;
  if (choice.outcome === "accepted") state.installed = true;
  emit();
  return choice.outcome;
}
