"use client";

import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { useSession } from "@/lib/auth/session";
import {
  INSTALL_DISMISS_KEY,
  installCardMode,
  isStandaloneDisplay,
  readDismissedAt,
  type InstallCardMode,
} from "@/lib/pwa/install";
import { promptInstall } from "@/lib/pwa/runtime";
import { usePwa } from "./pwa-runtime";

const PHONE_QUERY = "(max-width: 767px)";

/** Small dismissible "Install the app" card on Today, phones only. */
function subscribeDisplay(onChange: () => void) {
  const queries = [PHONE_QUERY, "(display-mode: standalone)"].map((q) =>
    window.matchMedia(q),
  );
  for (const query of queries) query.addEventListener("change", onChange);
  return () => {
    for (const query of queries) query.removeEventListener("change", onChange);
  };
}

/** Small dismissible "Install the app" card on Today, phones only. */
export function InstallCard() {
  const pathname = usePathname();
  const { status } = useSession();
  const { installPrompt, installed } = usePwa();
  // Server and hydration render nothing (not a phone, treated as installed).
  const isPhone = useSyncExternalStore(
    subscribeDisplay,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
  const standalone = useSyncExternalStore(
    subscribeDisplay,
    () => isStandaloneDisplay(window),
    () => true,
  );
  const [now] = useState(() => Date.now());
  const [dismissedAt, setDismissedAt] = useState<number | null>(() =>
    typeof window === "undefined" ? null : readDismissedAt(window.localStorage),
  );
  const mode: InstallCardMode = installed
    ? null
    : installCardMode({
        standalone,
        isPhone,
        signedIn: status === "authenticated",
        pathname,
        hasPrompt: installPrompt !== null,
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
        dismissedAt,
        now,
      });

  if (!mode) return null;

  const dismiss = () => {
    const at = Date.now();
    try {
      window.localStorage.setItem(INSTALL_DISMISS_KEY, String(at));
    } catch {
      // Storage blocked: the card simply comes back next time.
    }
    setDismissedAt(at);
  };

  return (
    <section
      aria-label="Install the app"
      data-install-card={mode}
      className="ck-noprint mb-4 flex items-start gap-3 rounded-2xl border border-border bg-surface p-3.5"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- 40 px static icon */}
      <img
        src="/icon-192.png"
        alt=""
        width={40}
        height={40}
        className="size-10 shrink-0 rounded-[9px]"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-foreground">
          Install the app
        </p>
        <p className="mt-0.5 text-[13px] leading-5 text-muted">
          {mode === "ios"
            ? "Tap Share, then Add to Home Screen."
            : "Open Sunpride from your home screen, full screen, like any app."}
        </p>
        <div className="mt-2.5 flex gap-2">
          {mode === "prompt" ? (
            <button
              type="button"
              onClick={() => void promptInstall()}
              className="min-h-11 rounded-lg bg-foreground px-4 text-[14px] font-semibold text-background"
            >
              Install
            </button>
          ) : null}
          <button
            type="button"
            onClick={dismiss}
            className="min-h-11 rounded-lg border border-border px-4 text-[14px] font-medium text-foreground"
          >
            Not now
          </button>
        </div>
      </div>
    </section>
  );
}
