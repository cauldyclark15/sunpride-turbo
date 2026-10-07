// Keeps the van-sales operating guide (QSR-018) honest: every bold screen word in the guide
// must exist in the van handheld app or the web app, and the numbers it quotes must match the
// policy constants the backend and handheld actually use. A renamed button or a changed
// threshold fails here instead of silently leaving sellers with wrong instructions.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const guide = readFileSync(
  join(root, "docs/guides/VAN_SALES_OPERATING_GUIDE.md"),
  "utf8",
);

function sources(dir: string, extensions: string[]): string {
  let text = "";
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name.endsWith(".test.tsx")) continue;
      text += sources(path, extensions);
    } else if (extensions.some((extension) => name.endsWith(extension))) {
      text += `\n${readFileSync(path, "utf8")}`;
    }
  }
  return text;
}

const handheld = sources(
  join(root, "apps/van-sales-android/app/src/main/java/com/sunpride/van"),
  [".kt"],
);
const web = sources(join(root, "apps/web/src"), [".tsx", ".ts"]);
const model = readFileSync(
  join(root, "packages/backend/convex/van/model.ts"),
  "utf8",
);

/**
 * Screen words that arrive with van lanes in the same pilot release but are not on main yet.
 * Remove an entry once its lane merges; the test then checks it like every other label.
 */
const PENDING_LANE_LABELS: Record<string, string> = {
  "Count stock": "SP-0117",
  "Same as expected": "SP-0117",
  "Save stock count": "SP-0117",
  "count code": "SP-0117",
  "Van stock count approval": "SP-0117",
  "Close trip": "SP-0118",
  "Before you close": "SP-0118",
  "Check these": "SP-0118",
  "Open receipts": "SP-0118",
  "I have checked these with my supervisor": "SP-0118",
  "Closed on this phone": "SP-0118",
  "Sync & posting": "SP-0119",
};

/** Bold words in the guide that are emphasis or spoken facts, not screen words. */
const NOT_SCREEN_WORDS = new Set([
  "Sync at the depot every morning.",
  "Count the load before you leave.",
  "Selling works without signal.",
  "Prices come from the office.",
  "Never sell twice to fix a mistake.",
  "One count each at the end of the day.",
  "Never uninstall the app, clear its data or sign in as someone else",
  "Contents:",
  "Scanning:",
  "Senraise H10P",
  "Sunpride Van Sales",
  "Sunpride Van Sales (Beta)",
  "email and password",
  "expected",
  "Every morning:",
  "delivery receipt, not a BIR official receipt",
  "When a receipt did not print:",
  "Bluetooth printer (only for handhelds without a built-in printer):",
  "receipt number",
  "total",
  "reason",
  "8-digit code",
  "trip number",
  "expected cash",
  "counted cash",
  "no more sales and no voids",
  "End-of-day hand-in (pilot):",
  "no web screens yet",
  "Important for the pilot:",
  "Do **not**",
  "not",
  "Approvals",
  "Phones",
  "Works offline:",
  "Saved only on the handheld for now:",
  "Sent to the office now:",
  "Not built:",
  "Practice data:",
  "Suggested training run (about 1 hour per seller):",
  "waiting",
  "to review",
  "paused",
  "saved on this phone",
  "Waiting",
  "To review",
  "Paused",
  "Saved on this phone",
  "Last sync",
  "REPRINT",
  "VOID - SALE CANCELLED",
]);

/** Guide shorthand for labels the app builds from data ("Print copy 2", "This is truck SMP-TRK-01 · ABC 123"). */
const TEMPLATES: Record<string, string> = {
  "Print copy N": "Print copy $copy",
  "Printed · N reprints left": "Printed · ${saved.reprintsLeft} reprints left",
  "This is truck …": "This is truck ${",
  "This is the … route": "This is the ${",
  "Charged to account · due …": "Charged to account · due $dueDate",
  Truck: "Truck ${",
  Route: "Route · ${",
};

function boldPhrases(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/\*\*([^*]+?)\*\*/g)) {
    found.add(match[1].trim());
  }
  return [...found];
}

describe("van-sales operating guide", () => {
  test("every bold screen word exists in the handheld or web app", () => {
    const missing = boldPhrases(guide).filter((phrase) => {
      if (NOT_SCREEN_WORDS.has(phrase) || phrase in PENDING_LANE_LABELS)
        return false;
      const needle = TEMPLATES[phrase] ?? phrase;
      return !handheld.includes(needle) && !web.includes(needle);
    });
    expect(missing).toEqual([]);
  });

  test("pending-lane labels are still listed in the guide", () => {
    for (const label of Object.keys(PENDING_LANE_LABELS))
      expect(guide).toContain(`**${label}**`);
  });

  test("cash tolerance matches the backend policy", () => {
    const minor = model.match(/cashVarianceToleranceMinor:\s*(\d+)n/)?.[1];
    expect(minor).toBeDefined();
    const pesos = (Number(minor) / 100).toFixed(2);
    expect(guide).toContain(`₱${pesos}`);
    // Every threshold the guide quotes ("above ₱…", "More than ₱…") is that tolerance.
    const quoted = [
      ...guide.matchAll(/(?:above|More than) ₱(\d[\d,]*(?:\.\d+)?)/g),
    ].map((match) => Number(match[1].replaceAll(",", "")).toFixed(2));
    expect(quoted.length).toBeGreaterThan(0);
    expect(new Set(quoted)).toEqual(new Set([pesos]));
    expect(pesos).toBe("50.00");
  });

  test("damage approval threshold matches the backend policy", () => {
    const units = model.match(/approvalFromUnits:\s*(\d+)/)?.[1];
    expect(units).toBe("12");
    expect(guide).toContain(`${units} selling units or more`);
  });

  test("reprint limit matches the handheld rule", () => {
    const max = handheld.match(/MAX_REPRINTS\s*=\s*(\d+)/)?.[1];
    expect(max).toBe("3");
    expect(guide).toContain(`At most ${max} reprints per sale`);
    expect(guide).toContain(`up to ${max} reprints`);
  });

  test("void, cash and load reasons cover the backend lists", () => {
    const listed = (name: string) =>
      [
        ...(
          model.match(new RegExp(`${name} = \\[([^\\]]+)\\]`))?.[1] ?? ""
        ).matchAll(/"([a-z_]+)"/g),
      ].map((match) => match[1]);
    expect(listed("VOID_REASONS")).toEqual([
      "wrong_items",
      "wrong_quantity",
      "wrong_customer",
      "wrong_payment",
      "customer_cancelled",
      "other",
    ]);
    expect(guide).toContain(
      "wrong items, wrong quantity, wrong customer, wrong payment, customer cancelled, or other",
    );
    expect(listed("CASH_VARIANCE_REASONS")).toHaveLength(7);
    expect(guide).toContain(
      "counting error, wrong change given, customer paid short, customer overpaid, cash lost or stolen, fake bill or coin, or other",
    );
    expect(listed("LOAD_DISCREPANCY_REASONS")).toEqual([
      "short_loaded",
      "over_loaded",
      "damaged_at_loading",
      "wrong_item",
      "other",
    ]);
  });

  test("payment methods match the backend list", () => {
    for (const label of [
      "Cash",
      "Check",
      "GCash",
      "Bank transfer",
      "Credit (charge to account)",
    ]) {
      expect(model).toContain(`label: "${label}"`);
      expect(guide).toContain(`**${label}**`);
    }
  });
});
