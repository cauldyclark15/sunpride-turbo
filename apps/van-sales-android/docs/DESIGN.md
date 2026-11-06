---
name: Sunpride Handheld POS (Store and Van)
description: A bright, rounded, red-accented till for cashiers and van sellers, built for one hand, direct sun and fast taps.
colors:
  sunpride-red: "#AB151C"
  sunpride-red-bright: "#D2282B"
  red-tint: "#FCE9E7"
  counter-ink: "#18181B"
  muted-ink: "#3F3F46"
  bar-ink: "#111111"
  canvas: "#FFFFFF"
  card: "#FAFAFA"
  hairline: "#D9D9DE"
  stock-green: "#0F5C33"
  alert-red: "#9E1220"
  amber-text: "#7A4200"
  amber-dot: "#E08A00"
typography:
  display:
    fontFamily: "System sans (Roboto)"
    fontSize: "44sp"
    fontWeight: 800
    lineHeight: "50sp"
  headline:
    fontFamily: "System sans (Roboto)"
    fontSize: "30sp"
    fontWeight: 700
    lineHeight: "36sp"
  title:
    fontFamily: "System sans (Roboto)"
    fontSize: "24sp / 18sp"
    fontWeight: 700
    lineHeight: "30sp / 24sp"
  body:
    fontFamily: "System sans (Roboto)"
    fontSize: "17sp / 15sp"
    fontWeight: 400
    lineHeight: "24sp / 21sp"
  label:
    fontFamily: "System sans (Roboto)"
    fontSize: "15sp / 14sp / 13sp"
    fontWeight: 600
    lineHeight: "20sp / 18sp / 16sp"
rounded:
  card: "20dp"
  row: "18dp"
  sheet: "28dp"
  pill: "full"
spacing:
  xs: "4dp"
  sm: "8dp"
  md: "12dp"
  lg: "16dp"
  touch: "48dp"
components:
  button-primary:
    backgroundColor: "{colors.sunpride-red}"
    textColor: "#FCFCFC"
    rounded: "{rounded.pill}"
    height: "56dp"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.counter-ink}"
    rounded: "{rounded.pill}"
    height: "56dp"
  nav-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted-ink}"
    height: "64dp"
  cart-bar:
    backgroundColor: "{colors.bar-ink}"
    textColor: "#FFFFFF"
    rounded: "28dp"
  list-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.counter-ink}"
    rounded: "{rounded.row}"
---

# Design System: Sunpride Handheld POS (Store and Van)

Applies to `apps/van-sales-android` in both modes (Store till and Van). Mode: **Operate**. Platform: native Android, Jetpack Compose, Material 3 structure with a Sunpride theme. Rebuilt in POS v2 (beta.30); replaces the earlier look-only notes.

## Overview

**Creative North Star: "The Bright Counter"**

A shop counter in daylight: clean white surfaces, one confident red, big honest numbers. The owner chose the BELION restaurant-POS reference (`_plans/sunpride-inv-pos/design-ref/`) and asked for a modern, easy-to-navigate app. POS v2 keeps that language (red contour title bars, rounded white sheet, pill controls, floating dark cart bar, photo-led cards) and fixes what made it hard to use: nothing to navigate by, an EXACT button that ended the sale, and a Payment screen that hid its options.

The scene decides the rest. A cashier or van seller holds a Senraise H10P (720x1440, 3-button navigation bar), often outdoors, one hand on the phone, scanning more than typing. So: light theme (not dark), 48dp targets, text at least 4.5:1 and key numbers at least 7:1, amounts that shrink instead of clipping, and one clear next action per screen. The scanner is the first input; the screen never asks for a tap the scan already did.

**Key characteristics**
- One accent: Sunpride red `#AB151C` (gradient to `#D2282B` only in title bars and the Checkout pill). Near-black `#111111` for the selected chip, selected tender and the floating cart bar. Everything else is white or a near-white card.
- Navigation by place, not by menu: a bottom bar with five destinations in each mode. Deep menus are gone.
- Money is the loudest thing on any screen it appears on.
- Plain, sentence-case copy. No codes, ids or jargon the cashier did not ask for.

## Colors

Restrained: neutrals plus one red; green, amber and alert-red only carry state.

- **Sunpride Red** `#AB151C`: primary actions, the selected tab, selected quantity steppers, peso signs in prices. 7.05:1 on the card tone.
- **Red Bright** `#D2282B`: the far end of the title-bar gradient. White text on it stays at 5:1 or better.
- **Red Tint** `#FCE9E7`: selected tab indicator, Add pill, option tile that has something applied, icon discs.
- **Counter Ink** `#18181B` / **Muted Ink** `#3F3F46`: text and secondary text (10:1 on white).
- **Bar Ink** `#111111`: cart bar, selected chip, selected tender, the "next step" card.
- **Stock Green** `#0F5C33`, **Alert Red** `#9E1220`, **Amber** `#7A4200` (text) with a `#E08A00` dot: stock and sync state. Never colour alone: "24 left", "Sold out", "3 waiting" always say it in words.
- Dark scheme exists in the theme but the handhelds run light; it is not reviewed.

## Typography

System sans (Roboto), no bundled font. All sizes are sp. Map text to roles; do not pick sizes per screen.

| Role | Size | Use |
|---|---|---|
| Display | 44sp ExtraBold | Payment total, cart total (shrinks to 14sp before it can clip) |
| Headline | 30 / 26sp | Key figures: sales this session, available stock |
| Title | 24 / 18sp | Title bars, card titles, list-row titles |
| Body | 17 / 15sp | Reading, hints, explanations |
| Label | 15 / 14 / 13sp | Buttons, chips, captions (13sp is the floor) |

Money goes through `FitText`, which measures and shrinks instead of clipping. Ratio between steps is about 1.15 to 1.25.

## Layout

- Phone portrait only, 360dp wide. Content padding 16dp, gaps 8 to 12dp, 48dp minimum targets, 8dp between targets.
- **Tab root screens** (Sell, Sales, Till, Stock, More; Today, Sell, Stock, Receipts, More): red title bar with a small sync badge at the right, no Back button, content scrolls, bottom bar below.
- **Pushed screens** (a customer, a count, a password form): title bar with a round Back button; the bottom bar stays so the user can always change place.
- **Sell grid**: header (avatar, name and role, store), search with camera, category chips, then a 2-column grid of compact cards (about 150dp: name, photo or initials tile, price, "24 left", Add or stepper). At least 2.5 rows are visible with an empty cart. The dark cart bar appears with the first item and floats above the bottom bar.
- **Payment**: Total / Tendered / Change, tender row, EXACT plus up to five bills, then Other amount, Discount and Customer tiles, all above a sticky Complete button. Nothing needs scrolling on 720x1440. The bottom bar is hidden.
- The bottom bar hides only where money is being taken (Payment, Complete) and in the two focused cash steps (open the till, count the drawer). Dialog sheets cover it.
- Window insets: the shell consumes the navigation-bar inset when the bar is showing, so no screen pads for it twice. The bar hides while the keyboard is open.

### Navigation map

| Mode | Tab | Root | Also holds |
|---|---|---|---|
| Store | Sell | grid | search, cart sheet, Payment, Complete (bar hidden in the last two) |
| Store | Sales | receipts | print, reprint, void, refund requests |
| Store | Till | status and session | open the till, X/Z and cash drawer, cash deposit, close the till |
| Store | Stock | receiving and counts | |
| Store | More | list | sync now, sync and posting, printer and scanner, customers and points, POS mode, account, sign out |
| Van | Today | next step and trip | load check, start trip, count cash, count stock, route controls, close trip |
| Van | Sell | customers | walk-in, customer, sale grid, Payment, Complete, returns |
| Van | Stock | truck stock | find a product, catalogue, record damage |
| Van | Receipts | this trip's receipts | print, reprint, void, collect |
| Van | More | list | sync now, sync and posting, printer and scanner, messages, report an issue, POS mode, account, sign out |

## Elevation & Depth

Mostly flat: white sheet, hairline borders `#D9D9DE`, tonal tint for selection. Soft shadows only where something floats: the cart bar (14dp, offset), bottom sheets and the sticky Complete bar (8 to 10dp). No coloured halos, no hard offset shadows.

## Shapes

Rounded everywhere, one family: pill (full) for buttons, chips, steppers, search and tender chips; 18 to 20dp for cards and list rows; 28dp for the sheet that rises under a title bar and for bottom sheets. The red title bar carries faint contour lines (decoration only, 10% white).

## Components

- **Primary button**: red pill, 56dp (60 to 64dp for Complete and Checkout). **Secondary**: white pill, hairline border. Disabled: grey fill, never hidden.
- **Bottom bar**: Material 3 `NavigationBarItem` x5 in a 64dp container (the stock bar is 80dp, too much of a 720x1440 phone). Selected: red icon in a tint capsule plus a red bold label; unselected: muted ink. Sync badge on More (amber count when work is waiting, red "!" when the office needs a person to look).
- **Sync badge** (`SyncPill`): white pill in the title bar: "All sent", "3 waiting", "Syncing…", "2 to review". Tap opens Sync and posting. It never covers content.
- **Product card**: name (2 lines), 44dp photo or initials tile, price with a red peso sign, stock in words, then a 48dp Add pill that becomes a minus / quantity / plus stepper in place (the grid does not jump).
- **Option tile** (Payment): 56dp rounded tile, label plus what is applied ("Senior citizen", a phone number); red outline and tint when something is applied.
- **Quick cash**: EXACT, then at most five bills. The bills are the next round-ups above the total and always PHP 100, 500, 1,000 when they cover it. EXACT or a bill only fills Tendered; the selected one is red with a check.
- **Complete**: the only control that saves a sale. Always on screen, grey until the payment is valid, then red.
- **List row**: card with a 40dp tinted icon disc, title, one plain line, chevron. **Empty state**: icon disc, what is true, what to do, one button.
- **Sheets** (cart, edit item, discount, customer): red title panel, white sheet with a rounded top, Done / Cancel as pills.

## Do's and Don'ts

Do
- Put the next action where the thumb is: bottom of the screen, 56dp or taller.
- Say what is applied on the control that applies it (discount name on the Discount tile).
- Show the reason a button is disabled, in plain words, near it.
- Keep scan-first: the grid never needs a tap to add what the scanner already added.

Don't
- Don't let any control other than Complete finish a sale (EXACT included).
- Don't hide the bottom bar on a normal screen, or add a sixth tab.
- Don't use colour alone for status, thin grey text on white, or amounts that can clip.
- Don't add a kicker above headings, nested cards, gradient text, or decorative motion.
- Don't invent product photos or categories the wire does not carry: initials tiles are the fallback.
