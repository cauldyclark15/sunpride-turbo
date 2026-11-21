/** SP-0216: channel keys (price lists, matrices) shown as names, never raw codes. */
const CHANNEL_NAMES: Record<string, string> = {
  gt: "General trade",
  pmot: "Public market",
  kas: "Key accounts",
  supermarket: "Supermarkets",
  mt: "Modern trade",
  horeca: "Food service",
  food_service: "Food service",
  institutional: "Institutional",
  distributor: "Distributors",
  van: "Van selling",
};

/** Plain name of a channel key; unknown keys become sentence case ("wet_market" -> "Wet market"). */
export function channelLabel(
  key: string | null | undefined,
  fallback = "Default",
): string {
  const k = String(key ?? "").trim();
  if (!k) return fallback;
  const known = CHANNEL_NAMES[k.toLowerCase()];
  if (known) return known;
  const words = k.replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
