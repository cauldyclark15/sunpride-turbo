import type { Tone } from "../format";

/** One restrained colour per status; the rest of the page stays monochrome. */
export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-[#2e9d59]",
  watch: "bg-[#d97706]",
  behind: "bg-[#c8102e]",
  info: "bg-[#27272a]",
  neutral: "bg-[#a1a1aa]",
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-[#1f7a43]",
  watch: "text-[#a15c07]",
  behind: "text-[#b4101f]",
  info: "text-foreground",
  neutral: "text-muted",
};

export const TONE_BAR: Record<Tone, string> = {
  ok: "bg-[#2e9d59]",
  watch: "bg-[#d97706]",
  behind: "bg-[#c8102e]",
  info: "bg-[#27272a]",
  neutral: "bg-[#a1a1aa]",
};
