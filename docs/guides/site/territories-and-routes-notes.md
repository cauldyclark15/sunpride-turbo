# Territories and routes guide — source and capture notes (SP-0212)

## Published files

- Source: `md/territories-and-routes.md`.
- Output: `apps/web/public/docs/sunpride-territories-and-routes.pdf`.
- Build: `python3 make-pdf.py md/territories-and-routes.md` from this directory.
- Listed under **For the office** in `apps/web/src/config/guides.ts`.

## Screenshot provenance

Captured on 19 November 2026 from the actual web application in worktree `sp-212`, base `4addb7bf`, using Chrome at 1440 × 1000 with device scale 1. API: `127.0.0.1:5000`; web: `127.0.0.1:5001`; database: **sunpride_lane_sp212**. No live customer data, phones, or production services were used. Screenshots are unaltered crops of the open forms, not drawings or mocked responses.

The sample office account, branches and people were prepared directly in the lane database. All displayed names are explicitly examples: Example branch, Example North, Example South, Example salesperson and Sample channel. They are not Sunpride's official branch/channel choices.

| Image | Actual form |
|---|---|
| `img/w-territories-add.png` | Add territory with today's start date, owning branch, channel and reason |
| `img/w-territories-person.png` | Add territory salesperson, dated tomorrow, with the branch-filtered list |
| `img/w-territories-route-add.png` | Add route with weekdays 1/3/5, a seven-day cycle and tomorrow's start |
| `img/w-territories-route-person.png` | Add route salesperson with Primary owner ticked |
| `img/w-territories-route-end.png` | Remove salesperson; the territory form has the same fields |
| `img/w-territories-move.png` | Move to another territory, empty route to Example South |
| `img/w-territories-remove.png` | Remove territory; Remove route has the same date/reason fields |

The first four forms were saved through the actual web controls. Territory, route, ownership and assignment results were read back through the normal authenticated read endpoints; future assignments were read at their chosen effective dates. The territory picker included Example salesperson and excluded Example other salesperson from the sibling branch. Weekdays `[1, 3, 5]`, cycle `7` and the route's primary assignment were checked in the saved results.

For the change/end screenshots only, the example territory, route and assignments were then given earlier start dates directly in the lane fixture so they represented established, current work. This is **not** a supported way to backdate through the website. With those prepared records, the actual web controls saved the route move, both assignment endings, and both deactivations; each exact result was read back. The move form was recaptured after dismissing the intentional date warning so it shows a clean, correctly filled form. The guide never tells readers they can backdate.

## Rules checked against current source

- `apps/api/src/domains/org/commands.js`, `geographyCommand`: required reason; today-or-later **territory creation only**; future dates for other dated changes; positive date intervals; weekday uniqueness/range; cycle range; owner coverage of the full route period; route/store dependencies; main-person and same-person overlap; ending an open assignment.
- Same file, `territoryWindow`, `personWindow`, `activeUnit`, `assertUnlocked`: complete active territory/branch coverage, employee branch hierarchy and later changes, and approved-plan locks.
- `apps/api/src/domains/org/model.js`: shared date, name, code, number and scheduled-change messages.
- `apps/web/src/lib/manila-date.ts`: Philippine date conversion and exact date messages.
- `apps/web/src/components/territory-admin.tsx`, `route-admin.tsx`, `outlet-assignments.tsx`: menu/form labels, Primary owner, assignment selection, and store reassignment controls.
- `apps/api/src/domains/org/index.js`: ending by assignment selection resolves the selected person and territory/route before calling the command.

Two distinctions matter for accuracy:

1. The **territory** salesperson picker filters by the owning branch and selected date. The current **route** picker filters by the administrator's scope, which can be wider. The guide states this explicitly instead of promising that every listed route candidate is eligible; the save still enforces the owner hierarchy. This issue changes documentation, not assignment permissions or picker behavior.
2. Today is allowed when **adding a territory**, not for territory salesperson assignments, moves, endings or deactivation. Routes remain future-dated. The guide preserves this distinction rather than widening the rule.

A territory deactivation checks remaining route-territory associations as well as stores. The guide therefore tells readers to **move the routes out**, not to assume that stopping a route alone clears its territory association.

Five refused public commands were also exercised on the sample data: outside-owner person, overlapping main assignment, a route outlasting its territory, yesterday's territory start, and missing reason. Each returned its documented message. Route history was identical before/after; neither refused creation appeared in the lists.

## Publication checks

- Built with the existing `make-pdf.py`; six A4 pages, seven full-width screenshots.
- Rendered every PDF page with PDFKit and inspected for readable forms, clipped text and near-empty pages. None remained.
- On a production-mode lane web build, signed in and opened **Guides > For the office > Territories and routes**. Open opened the PDF, Download returned the same bytes as the generated file, and Copy link put the absolute lane address on the browser clipboard.
- An anonymous request returned the same PDF with HTTP 200, `application/pdf` and `Cache-Control: no-cache`.
- This is lane/sample verification only, **not a live-site release or client acceptance**.
