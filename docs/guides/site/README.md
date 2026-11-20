# Published how-to guides (SP-0201)

These are the sources of every guide on the website's **Guides** page (`/guides`). The built PDFs live in
`apps/web/public/docs/` and are public (no sign-in), so links shared over Viber and email keep working.
The list on the page is `apps/web/src/config/guides.ts`.

**Never rename a published PDF.** Refresh a guide by rebuilding the same file name.

## Layout

| Path | What |
|---|---|
| `md/<name>.md` | One guide in plain markdown. Builds `apps/web/public/docs/sunpride-<name>.pdf`. |
| `img/` | Screenshots used by the md guides (`w-*` website at 1440 wide, `p-*` phone, others kept from 13 Nov). |
| `make-pdf.py` | md -> HTML -> PDF (headless Chrome, A4). |
| `add-customers/build.py` | Builds `sunpride-add-customers.pdf` (the 18 Nov phone guide) from `add-customers/shots/`. |
| `add-customers/shots/CAPTURE-NOTES.md` | How and where the phone shots were taken. |

## Rebuild

```sh
cd docs/guides/site
python3 make-pdf.py                       # every md guide
python3 make-pdf.py md/office-guide.md    # one guide
python3 add-customers/build.py            # the add-customers guide
```

Needs Google Chrome at `/Applications/Google Chrome.app`. Then run the web tests
(`cd apps/web && bunx vitest run src/components/guides`): they check every listed file exists and is a PDF.

## Markdown rules (make-pdf.py)

- `# Title`, `## Section`, numbered steps (`1. `), bullets indented with three spaces (`   - `).
- A line made only of images becomes a row of figures: `![caption](../img/x.png "phone")`.
  Kinds: `phone`, `web`, `wide` (full width), `strip` (short), `right` (one phone shot floated beside the steps).
- Lines starting with `>` make the boxed "If something goes wrong" note.

## Adding a guide

1. Write `md/<name>.md` (plain short English, numbered steps, one action per step, exact on-screen labels).
2. `python3 make-pdf.py md/<name>.md` and check the pages (no near-empty page, readable screenshots).
3. Add it to `GUIDE_GROUPS` in `apps/web/src/config/guides.ts` under the right audience.

## Screenshots

SP-0217 refresh: `img/w-people-selected.png` and `img/w-set-app-mode.png` were recaptured from the actual local web application using only explicitly named example people in `sunpride_lane_sp217` (API 5000, web 5001, Chrome 1440 × 1000). The People list now says **Branch** and **No branch**. No app mode was saved. The office, app-mode, and territories-and-routes PDFs were rebuilt at their existing published paths. These are sample screenshots, not live customer or production proof.

Take website shots from a lane or sample database, never live customer data. Phone shots come from the
Xiaomi test phone with the DEV app on a lane server (see `add-customers/shots/CAPTURE-NOTES.md`).
