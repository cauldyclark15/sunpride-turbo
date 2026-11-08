# Sunpride Office — iOS design (SP-0165)

Mode: **Operate.** The office checks figures, decides approvals and looks up stores between meetings, on an
iPhone in one hand or an iPad on a desk. Scanability, consistency and native expectations come first; the
brand lives in one tint and a few precise details. (Impeccable's discovery interview could not run inside a
delegated lane; the brief, PRODUCT.md and the web app's information architecture stood in for it.)

## Structure

- **Five sections, bottom navigation on every device:** Today, Decide, Stores, Stock, More — the web
  owner pages (`apps/web/src/config/navigation.ts`) folded to what the office does away from a desk.
  - iPhone: the system `TabView` tab bar (Liquid Glass by the system), Decide badged with the open count.
  - iPad: the system puts tabs at the top, so the app draws its own **floating Liquid Glass bar at the
    bottom** (`GlassTabBar`): one `GlassEffectContainer`, a glass capsule holding the sections and a tinted,
    interactive glass lens on the selected one that morphs between items (`glassEffectID`). Same five
    sections, same badge, ⌘1–⌘5, pointer hover, VoiceOver tab traits; it steps aside while the keyboard is up.
    Every screen reserves the bar's height (`.padBarSpace()`), so lists and bottom actions never sit under it.
- **Inside a section:** `AdaptiveSplit` — list + detail (`NavigationSplitView`, balanced) on a landscape
  iPad; a single pushed stack on iPhone and iPad portrait (a 2-column split in portrait squeezes both).
- Large titles on section roots, inline titles on details; sheets for the one focused task (confirming a
  decision, reviewing a gathered store), with Cancel / confirm in the toolbar.

## Materials and color

- System materials only: tab bar, nav bars, `.glassEffect`, `.glass` / `.glassProminent` buttons. No
  hand-rolled blur. Content sits on grouped system backgrounds (`secondarySystemGroupedBackground` tiles).
- **One tint:** Sunpride red, made text-safe — `#B4151D` light (6.85:1 on white), `#FF5A60` dark. The raw
  brand red `#EE1C25` appears only on the badge and the map pin.
- Status = words + SF Symbol + color (`StatusPill`, `Tone`), never color alone. Good `#237A44` / dark
  `#5ECD88`; watch `#9E6600` / `#FFD14D`; bad `#C8102E` / `#FF6B6B`.
- Dark Mode is designed, not inverted: every color is a dynamic pair.

## Type and numbers

- SF Pro via Dynamic Type text styles only; figures use `.monospacedDigit()`. KPI grids drop to one
  column at accessibility sizes; the iPad bar hides its labels at accessibility sizes (icons + VoiceOver).
- Money in Philippine pesos from integer centavos (`₱2,921,111`, `₱1,053,522.92` where centavos matter,
  `−` for negatives). Dates and times are Manila time (`Asia/Manila`), en-PH (`Sun 8 Nov`, `3:05 PM`).
- Plain words: server status codes go through `Format.words` (`on_route` → “On the road”); no ids or
  codes on screen except document numbers the office uses to talk about a document.

## States

Every remote screen uses `Remote` + `RemoteView`: a redacted skeleton the first time, pull-to-refresh, a
plain-words problem with **Try again** (“You're offline…”), and a slim glass banner when a refresh fails but
the last copy is still shown. Empty lists say what will appear there.

## Haptics

Success / warning on a decision and on sign-in; a selection tick when switching sections.
