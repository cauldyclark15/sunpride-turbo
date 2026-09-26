# Calm workspace pattern

The layout, spacing, and copy rules for every Sunpride screen: web, PWA, iOS, and Android.
Colors stay as they are in `DESIGN.md`. This file only covers how the colors are used, plus
geometry, type, and words. When this file and `DESIGN.md` disagree about layout or copy,
this file wins.

The goal is calm: mostly white and neutral, thin lines, one strong action per screen, and
very few words.

## 1. Principles

1. **About 90% of every screen is neutral.** Use Sunpride red only for the primary action,
   active navigation or tab, and selected state. Status colors appear as soft tints, never
   as large saturated fills.
2. **Lines, not shadows.** Resting surfaces get a 1px `border` and no shadow. Only floating
   layers (popover, modal, sheet, toast) get `shadow-overlay`.
3. **One big text size per screen**, the page title. Everything else is 11–15px and gets
   its hierarchy from weight, case, and color.
4. **Fragments, not sentences.** Use labels, counts, and meta lines joined with ` · `. Never
   explain the system on screen.
5. **Every control is 40px tall.** Row-level actions are 32px. Nothing sits in between.
6. **Leave space empty.** Don't stretch content, add filler, or decorate edges.

## 2. Shell (web and PWA)

- **Canvas:** `bg-background`. At `lg` and wider, the whole app sits in one frame: the canvas
  has `p-3`, and the frame is `bg-surface`, `border border-border`, `rounded-3xl`, and
  `overflow-hidden`. Below `lg` there is no inset.
- **Sidebar:** Inside the frame, separated from content by a single `border-r border-separator`,
  with no fill change. It contains, in order:
  - **Workspace brand:** a 36px logo tile, name, and descriptor.
  - **Nav groups:** each has an 11px uppercase muted label, and hairline separators sit
    between groups. Nav rows are 36px with an 18px outline icon, 14px label, and an
    optional count badge.
  - **User card:** pinned at the bottom, with a 32px circular avatar showing the initial of
    the displayed name, the name, and the role.
- **Content:** `px-6 py-5`, with a maximum width only for reading-heavy pages. Keep a 16px
  (`gap-4`) gap between blocks.
- **Mobile:** The sidebar becomes a drawer. The PWA keeps its 3-item bottom bar.

## 3. Page header

```
Title (26px, semibold, tracking-tight)             [Secondary] [Secondary] [Primary]
Stat line (13px muted) — e.g. "6 visits · 2 need action"
```

- No eyebrow label and no description paragraph.
- The stat line is optional. It must be live numbers, and it is never an explanation.
- A page has at most one primary (red) button. All other buttons are outlined secondary.

## 4. Cards and sections

- **Card:** `bg-surface border border-border rounded-2xl`, no shadow.
- **Card header:** 48px tall, `px-4`, with a hairline below. It contains, left to right:
  - a 14px icon;
  - an **11–12px uppercase muted label** with `tracking-wide`;
  - an optional ` · N` count;
  - small actions on the right.
- **Card body:** `p-4`, or edge-to-edge for lists and tables.
- **Placement:** Every section lives in a card. Nothing floats between cards, and cards are
  never stacked inside other cards.
- **Two-column pages:** On `xl` screens, use a flexible main column plus a `w-[360px]` side
  column for secondary panels (needs action, filters, settings).
- **Tinted notice** (replaces banners): a soft status fill (`bg-*-soft
  text-*-soft-foreground`), no border, `rounded-xl p-3`, with a title plus one meta line.
  - Show it only when someone must act.
  - A healthy state gets no banner. If needed, a status pill in the header is enough.
  - Success is green and never red.

## 5. Lists

A row is 56px tall, with a hairline between rows and no zebra striping. Left to right:

1. A 36px **icon tile** (`rounded-[10px]`, soft status tint, 18px icon in the tint's
   foreground).
2. **Title** (14px, medium) above a **meta line** (13px, muted, fragments joined with ` · `).
3. Right-aligned: a value or time (13px, `tabular-nums`; use mono for codes and timestamps),
   then an optional 32px action button, then an optional 6px status dot.

Group rows under an 11px uppercase muted label (TODAY, WAITING). Don't add table headers
to lists.

## 6. Tables

- **Header row:** 11px uppercase muted labels with `tracking-wide`, no fill, and a hairline
  below.
- **Rows:** 52px with a hairline between them. Row hover (`bg-surface-hover`) is only for
  clickable rows.
- **First column:** two lines, the name (14px medium) above a code (12px mono muted).
- **Numbers:** right-aligned with `tabular-nums`. Status appears as a pill, never as colored
  text alone.
- **Width:** The table spans its card so dividers reach both edges. The first (name)
  column absorbs spare width; numeric columns stay content-sized. No divider under the last
  row (the card edge closes it).

## 7. KPIs

- Each KPI is its own bordered card with `p-4`, containing:
  - an uppercase 11px muted label;
  - a 28px medium `tabular-nums` number;
  - a 13px muted unit or change (1–3 words).
- No rings, icons, or edge decoration.
- Put a unit shared by every card in the section label ("CASES"), not in each card.

## 8. Controls

| Control | Spec |
|---|---|
| Button, primary | 40px, `rounded-[10px]`, accent fill, 14px medium label, optional 16px leading icon |
| Button, secondary | 40px, surface fill, 1px `border`, same label |
| Row action | 32px, `px-3`, 13px label; primary or secondary |
| Icon button | 40px square, outlined; may carry a 6px dot |
| Input, select, date | 40px, HeroUI field components only, 1px border, `rounded-[10px]`, 16px leading icon where useful. Never unstyled native controls |
| Field label | 13px medium, 6px above the field. Stacked labels, never inline |
| Tabs | One style: underline tabs, 40px, 14px. Active tab is foreground semibold with a 2px accent underline; inactive tabs are muted. More than 6 tabs scroll horizontally |
| Filters | Outlined 40px dropdown buttons (icon + value + chevron) in the page header row or card header |
| Toggle | For on/off settings rows: label, caption, toggle on the right |
| Pill | Content-sized, `rounded-md`, `px-2 py-0.5`, 12px medium, soft tint. Tones: success, warning, danger, neutral. Active ≠ draft: use different tones |
| Count badge | Solid danger, white 11px numeral, only for counts that need action |
| Avatar | Circle: 32px in the user card, 24px in stacks (overlapping by 30%) |

Icons use the outline style with a 1.5 stroke and inherit the text color. Sizes are 18px in
navigation, 16px in controls, and 14px in card headers.

## 9. Type

| Role | Size / weight | Case |
|---|---|---|
| Page title | 26px / 600, tracking-tight | Sentence |
| KPI number | 28px / 500, tabular | — |
| Row / card title | 14px / 500 | Sentence |
| Body, meta | 13px / 400, muted | Sentence fragments |
| Section, group, table header | 11–12px / 500, `tracking-wide` | UPPERCASE |
| Caption | 12px / 400, muted | Sentence |
| Code, time, ID | 12–13px mono, tabular | As data |

The font is Mulish. The heaviest weight is 600, and nothing is bold beyond that.

## 10. Copy

Every word must earn its place.

- **Page titles:** 1–2 words ("Coverage", "Inventory", "Visits").
- **Section labels:** 1–3 words plus a count.
- **Buttons:** a verb plus a noun, 1–2 words ("New plan", "Check in", "Sync").
- **Row titles:** 3–6 words. **Meta lines:** 2–4 fragments, not sentences.
- **Helper text** appears only when it prevents an error. Keep it to 6 words or fewer, and
  put policy explanations behind an info icon tooltip or remove them.
- **Empty states:** one line of 6 words or fewer, plus one action ("No visits today").
- **Toasts and confirmations:** 3 words or fewer ("Visit saved", "Synced").
- **Errors:** what happened and what to do, 10 words or fewer ("No signal. Saved on phone.").
- **Never on screen:** internal terms (SAP, ledger, idempotent, provisional, authority,
  operational, version numbers), time-zone notes, "please", or restating what the title
  already says.
- **Units** appear once per group, not in every cell.

### Before → after

| Before | After |
|---|---|
| Inventory control / "Lot-aware stock, receiving, transfers, counts, manufacturing, rolling trucks, and an immutable movement ledger." | Inventory / "240 cases · 1 location" |
| "Physical 240 base cases across filtered locations" | PHYSICAL 240 (section label: STOCK · CASES) |
| Banner "Inventory is ready. Locations, units, and product rules are configured." | (nothing) |
| "Sales force automation" + description | Coverage |
| "Operational sites are distinct from SAP customer accounts. Pin radius 75 m by default (provisional)." | (removed; pin radius shown as the "75 m" meta on each outlet) |
| "Schedule templates only; ordered outlet stops are managed separately. Asia/Manila dates." | (removed) |

## 11. Native (iOS and Android)

The same rules apply, translated to each platform:

- **Canvas and cards:** `background` canvas, with white cards (16pt radius, 1px separator, no
  shadow).
- **Screen title:** a large title, then a stat line.
- **Sections:** uppercase 12pt section labels, then list rows 56pt tall with an icon tile,
  title, and meta line.
- **Actions:** one filled red primary action, pinned at the bottom within thumb reach.
  Secondary actions are outlined. Every target is at least 44pt (iOS) or 48dp (Android).
- **Sync state:** one compact pill in the top bar (All synced · 3 waiting · Offline). It is
  never a full-width banner, unless someone must act (removed phone, sign in again).
- **Text scaling:** Use system text styles scaled to this table, and respect Dynamic Type
  and font scale.
