/**
 * Install card rules (pure, so they are unit-tested):
 * - never when the app already runs installed (display-mode standalone);
 * - only on phones, only after sign-in, only on Today;
 * - Android/Chrome when the browser offered `beforeinstallprompt`;
 * - iPhone Safari with the "Share, then Add to Home Screen" steps;
 * - after a dismiss, quiet for 14 days.
 */

export const INSTALL_DISMISS_KEY = "sp.install.dismissedAt";
export const INSTALL_QUIET_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type InstallCardMode = "prompt" | "ios" | null;

export type InstallContext = {
  standalone: boolean;
  isPhone: boolean;
  signedIn: boolean;
  pathname: string;
  /** The browser fired `beforeinstallprompt` and we kept the event. */
  hasPrompt: boolean;
  userAgent: string;
  /** ms epoch of the last dismiss, or null. */
  dismissedAt: number | null;
  now: number;
};

/** iPhone/iPod Safari (not Chrome/Firefox/Edge for iOS, which cannot add to home screen the same way). */
export function isIosSafari(userAgent: string) {
  if (!/iPhone|iPod/.test(userAgent)) return false;
  return !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(userAgent);
}

export function installCardMode(context: InstallContext): InstallCardMode {
  if (context.standalone || !context.isPhone || !context.signedIn) return null;
  if (context.pathname !== "/today") return null;
  if (
    context.dismissedAt !== null &&
    context.now - context.dismissedAt < INSTALL_QUIET_DAYS * DAY_MS
  )
    return null;
  if (context.hasPrompt) return "prompt";
  if (isIosSafari(context.userAgent)) return "ios";
  return null;
}

export function readDismissedAt(storage: Pick<Storage, "getItem">) {
  const raw = Number(storage.getItem(INSTALL_DISMISS_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** True when the page runs as the installed app (Android standalone or iOS home screen). */
export function isStandaloneDisplay(win: Window) {
  return (
    win.matchMedia?.("(display-mode: standalone)").matches === true ||
    (win.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
