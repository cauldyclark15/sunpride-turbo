import { REF_TYPES, type RefEntry, type RefType } from "./types";

/**
 * Canonical body tokens (MESSAGING_V2 "Message body tokens"):
 *   `<@user:UUID>`  user mention
 *   `<#TYPE:ID>`    object tag
 *   `<!channel>`    notify everyone
 * Clients render them as chips and never show the raw token.
 */
export type BodySegment =
  | { kind: "text"; text: string }
  | { kind: "user"; id: string }
  | { kind: "ref"; type: RefType; id: string }
  | { kind: "channel" }
  | { kind: "link"; url: string };

const REF_TYPE_SET = new Set<string>(REF_TYPES);
const TOKEN =
  /<@user:([0-9a-fA-F-]{36})>|<#([a-z_]+):([^<>\s]+)>|<!channel>|(https?:\/\/[^\s<>]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]'"]+$/;

/** What a tag is called when its title has not been resolved. */
export const REF_NOUNS: Record<RefType, string> = {
  user: "person",
  outlet: "store",
  product: "item",
  customer: "customer",
  issue: "issue",
  order: "order",
  visit: "visit",
  territory: "territory",
  route: "route",
  van_trip: "van trip",
};

export function isRefType(value: string): value is RefType {
  return REF_TYPE_SET.has(value);
}

export const userToken = (userId: string) => `<@user:${userId}>`;
export const refToken = (type: RefType, refId: string) => `<#${type}:${refId}>`;
export const CHANNEL_TOKEN = "<!channel>";

/** Splits a stored body into text, chips and links, in order. */
export function parseBody(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = segments.at(-1);
    if (last?.kind === "text") last.text += text;
    else segments.push({ kind: "text", text });
  };
  let cursor = 0;
  for (const match of body.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    pushText(body.slice(cursor, index));
    cursor = index + match[0].length;
    const [, userId, type, refId, url] = match;
    if (userId) segments.push({ kind: "user", id: userId.toLowerCase() });
    else if (type && refId) {
      if (isRefType(type)) segments.push({ kind: "ref", type, id: refId });
      // An unknown type is never shown raw; the server refuses them anyway.
      else pushText("");
    } else if (url) {
      const trailing = url.match(TRAILING_PUNCTUATION)?.[0] ?? "";
      const clean = trailing ? url.slice(0, -trailing.length) : url;
      segments.push({ kind: "link", url: clean });
      cursor -= trailing.length;
    } else segments.push({ kind: "channel" });
  }
  pushText(body.slice(cursor));
  return segments;
}

/** Every object tag in a body, for `POST /refs/resolve` when refs are absent. */
export function refsInBody(body: string) {
  return parseBody(body).flatMap((segment) =>
    segment.kind === "ref" ? [{ type: segment.type, id: segment.id }] : [],
  );
}

export type NameLookup = {
  user: (userId: string) => string | undefined;
  ref: (type: RefType, refId: string) => RefEntry | undefined;
};

/** One-line plain text for previews and notifications (no raw tokens). */
export function plainText(body: string, lookup: NameLookup): string {
  return parseBody(body)
    .map((segment) => {
      switch (segment.kind) {
        case "text":
          return segment.text;
        case "user":
          return `@${lookup.user(segment.id) ?? "someone"}`;
        case "ref": {
          const ref = lookup.ref(segment.type, segment.id);
          return `#${ref ? refTitle(ref) : REF_NOUNS[segment.type]}`;
        }
        case "channel":
          return "@channel";
        case "link":
          return segment.url;
      }
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** The title a reader may see: restricted and missing refs never leak. */
export function refTitle(ref: RefEntry | undefined): string {
  if (!ref) return "Item";
  if (ref.access === "restricted") return "Restricted item";
  if (ref.access === "missing") return "Removed item";
  return ref.title;
}

/**
 * Composer insertions. The textarea shows readable labels (`@Ana Cruz`,
 * `#Puregold Cubao`); on send each label becomes its token.
 */
export type DraftInsert = { label: string; token: string };

export function serializeDraft(text: string, inserts: readonly DraftInsert[]) {
  let out = text;
  const ordered = [...inserts].sort((a, b) => b.label.length - a.label.length);
  for (const insert of ordered)
    if (insert.label) out = out.split(insert.label).join(insert.token);
  return out.replace(/(^|\s)@channel\b/g, `$1${CHANNEL_TOKEN}`).trim();
}

/** Turns a stored body back into an editable draft plus its insertions. */
export function bodyToDraft(
  body: string,
  lookup: NameLookup,
): { text: string; inserts: DraftInsert[] } {
  const inserts: DraftInsert[] = [];
  const text = parseBody(body)
    .map((segment) => {
      switch (segment.kind) {
        case "text":
          return segment.text;
        case "link":
          return segment.url;
        case "channel":
          return "@channel";
        case "user": {
          const label = `@${lookup.user(segment.id) ?? "someone"}`;
          inserts.push({ label, token: userToken(segment.id) });
          return label;
        }
        case "ref": {
          const label = `#${refTitle(lookup.ref(segment.type, segment.id))}`;
          inserts.push({ label, token: refToken(segment.type, segment.id) });
          return label;
        }
      }
    })
    .join("");
  return { text, inserts };
}

/**
 * The `@` or `#` word being typed at the caret, if any:
 * `"hi @an|"` → `{ trigger: "@", query: "an", start: 3 }`.
 */
export function activeTrigger(
  text: string,
  caret: number,
): { trigger: "@" | "#"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)([@#])([^\s@#]{0,40})$/);
  if (!match) return null;
  const query = match[3] ?? "";
  const trigger = match[2] as "@" | "#";
  return { trigger, query, start: caret - query.length - 1 };
}

/** Replaces the trigger word with `label + " "`; returns the new text and caret. */
export function applyTrigger(
  text: string,
  caret: number,
  start: number,
  label: string,
) {
  const next = `${text.slice(0, start)}${label} ${text.slice(caret)}`;
  return { text: next, caret: start + label.length + 1 };
}
