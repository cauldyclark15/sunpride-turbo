# Sunpride Field: design

Mode: **Operate**. The user is a field sales agent on a Samsung-class Android phone (1080x2340, sometimes 720x1440), one-handed, in sun, between stores, often offline. The app is a tool: the next action must be obvious and the way back must always be on screen.

A sibling of the van-sales POS app (`SellingLook.kt`): light surfaces, rounded cards, pill controls, one strong accent, a dark floating summary bar. It is not a copy; field sales is a plan-and-visit app, not a till.

## Navigation

Five tabs in a Material 3 `NavigationBar` (`ui/FieldNav.kt`). Labels always shown; the active tab is a tinted pill. Messages carries an unread badge. The bar hides on the keyboard.

| Tab | Page | What it holds |
| --- | --- | --- |
| Today | `home` | day progress, next stop, the day's stops, team, sales, targets |
| Route | `route` | the stops in order with distance, directions, Start visit |
| Stores | `customers`, `customer` | search, "On today's route" filter, store detail |
| Messages | `messages` | team chat (list uses the app header; a chat uses its own bar) |
| More | `more` | catalogue, new store, attendance, collections, work-with, team, earned statements, sync, battery guide, account and settings, support info, sign out |

Rules:
- **Drill-downs keep their tab.** Account, Sync, Support, Catalogue and the other tools open from More (or from the sync pill) and return to where they came from (`origin`).
- **The bar hides only where it would distract**: inside a store visit (call sheet, order, photo, activity form, end-call), sign-in/registration/lock, partner mode, forms that need full attention (census, attendance, prospects, collections, work-with, change password, location consent). Those keep a clear Back in the header.
- Back key unwinds one step; from a tab it goes to Today; only Today leaves the app.

## Layout

- Header: deep red gradient with faint contour lines (`FieldHeader`), white title, round Back and Profile buttons, sync status pill. Content sits on a white sheet with 28dp top corners.
- Edge to edge: the header draws under the status bar; the nav bar draws over the gesture area with insets applied once. Status-bar icons are forced light while the red header is on screen.
- Screen padding 16dp; section gap 12–16dp; card padding 16dp; list rows 72dp minimum.
- Touch targets 48dp minimum; primary buttons 52dp tall, full width, pill.

## Type

Material 3 type scale on the system font (no unlicensed fonts bundled). Screen title in the header (`titleLarge`, white); one page heading at most inside the sheet (`headlineSmall`/`titleMedium`); card titles `titleSmall`; body 14–16sp; captions `bodySmall` 12sp, never below. Sentence case, plain words ("Start visit", "Stores", not "Outlets / Customers").

## Colour

| Role | Value |
| --- | --- |
| Accent (buttons, selection, links on white) | `#AB151C` (white text 7.3:1) |
| Header gradient | `#AB151C` → `#D2282B` |
| Brand red (logo, decoration only) | `#EE1C25` |
| Surface / canvas | white / `#F5F5F5` |
| Card | `#FAFAFA` with `#D9D9DE` hairline |
| Selected tint | `#FCE9E7` with text `#8E1117` |
| Floating bar | `#111111` with white text |
| Good / warn / bad chips | tinted fill + dark text, ≥4.5:1 (`LookContrastTest`) |

Red means "act or attention"; it is not decoration inside the sheet. Status is never colour alone: chips carry a word.

## Components (`ui/CalmComponents.kt`, `ui/FieldLook.kt`)

`FieldHeader`, `SectionCard`/`LookCard`, `ListRow` (optional leading and trailing slots), `IconTile`, `StatusChip`, `FilterPill`, `SearchField`, `PrimaryBottomButton`, `SecondaryButton`, `TonalButton`, `EmptyState`, `CallProgressCard`/`ProgressBar`, `Glyph` icon set (drawn in code, no icon font). Existing signatures are kept so earlier screens and tests compile; test tags are unchanged.

## Today

1. Greeting, route, date in the header.
2. Find a store (search).
3. Call progress card: "N of M stores done", bar, productive count.
4. Stops list: green check when done, numbered tile otherwise; next stop outlined in red with a "Next" pill.
5. Floating dark bar: next store name, area, **Start**. It sits above the nav bar and the list scrolls clear of it.

## Empty and error states

Every list has an explained empty state (icon, one sentence of why, one sentence of what to do). Offline is stated once ("Saved on this phone"), not as an error.

## Not in scope

No wire, schema, API or business-logic change. No new fonts, no illustrations, no motion beyond Material defaults.
