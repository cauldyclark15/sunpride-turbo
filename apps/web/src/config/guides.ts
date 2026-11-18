/**
 * SP-0201: every how-to and PDF guide, published as static files under `public/docs/` and listed on
 * the Guides page by audience. The file names are stable links people share over Viber and email:
 * refresh a guide by rebuilding the same file (docs/guides/site/README.md), never by renaming it.
 * The files are public (no sign-in) on purpose: they hold no private data.
 */

export type Guide = {
  /** Stable id; also the anchor on the Guides page. */
  id: string;
  title: string;
  /** One line: what it helps with. */
  line: string;
  /** Path on this website, under /docs/. */
  href: string;
};

export type GuideGroup = { id: string; title: string; guides: Guide[] };

const doc = (name: string) => `/docs/sunpride-${name}.pdf`;

const INSTALL: Guide = {
  id: "install-field-app",
  title: "Install the Field app (Google Play)",
  line: "Join the Google Play test, install Sunpride Field and register your phone.",
  href: doc("install-field-app"),
};
const UPDATE: Guide = {
  id: "update-field-app",
  title: "Update the Field app",
  line: "Turn on automatic updates, or update right now from the Play Store.",
  href: doc("update-field-app"),
};
const PASSWORD: Guide = {
  id: "forgot-password",
  title: "Forgot password / temporary password",
  line: "Reset your own password, or sign in with a temporary password from the office.",
  href: doc("forgot-password"),
};
const MESSAGES: Guide = {
  id: "messages-guide",
  title: "Messages",
  line: "Chat with your team and ask the developers for help, on the phone or the website.",
  href: doc("messages-guide"),
};
const ISSUES: Guide = {
  id: "issues-guide",
  title: "Report a problem (Issues)",
  line: "Report a problem or ask for a change, then follow it until it is fixed.",
  href: doc("issues-guide"),
};

export const GUIDE_GROUPS: GuideGroup[] = [
  {
    id: "salesmen",
    title: "For salesmen",
    guides: [
      INSTALL,
      UPDATE,
      {
        id: "add-customers",
        title: "How to add customers",
        line: "Add a new customer on the phone, with pictures of every step.",
        href: doc("add-customers"),
      },
      {
        id: "field-app-guide",
        title: "Field app guide for salesmen",
        line: "First sign-in, your app mode, your day, and how to check that everything is sent.",
        href: doc("field-app-guide"),
      },
      PASSWORD,
      MESSAGES,
      ISSUES,
    ],
  },
  {
    id: "managers",
    title: "For managers",
    guides: [
      {
        id: "manager-guide",
        title: "Website guide for managers",
        line: "Approve or reject new customers and watch your field team.",
        href: doc("manager-guide"),
      },
      PASSWORD,
      MESSAGES,
      ISSUES,
    ],
  },
  {
    id: "office",
    title: "For the office",
    guides: [
      {
        id: "office-guide",
        title: "Website guide for the office",
        line: "Register phones, approve customers, phone saves, passwords and the field team.",
        href: doc("office-guide"),
      },
      {
        id: "set-app-mode",
        title: "Set a person's app mode",
        line: "Choose Customer mapping, Field visits or Truck selling for each person.",
        href: doc("set-app-mode"),
      },
      INSTALL,
      UPDATE,
      MESSAGES,
      ISSUES,
    ],
  },
];

/** Every published file once (a guide can sit in more than one group). */
export const GUIDE_FILES: string[] = [
  ...new Set(GUIDE_GROUPS.flatMap((g) => g.guides.map((guide) => guide.href))),
];

/** The address to share: this website's origin plus the file path. */
export function absoluteGuideUrl(origin: string, href: string): string {
  return new URL(href, origin).toString();
}

/** The name the browser saves a download under. */
export const downloadName = (href: string) => href.split("/").pop() ?? href;
