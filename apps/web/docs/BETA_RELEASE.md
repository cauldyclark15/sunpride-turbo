# Beta release: web dashboard for client testers

Sunpride testers use the management web app from this release and report problems in the
in-app issue tracker. Anything not ready is **hidden, not deleted**: the code stays, and the
beta feature list in `src/config/beta.ts` decides what is shown.

## What is hidden

| Key                 | What testers no longer see                                                                  | Why                                             |
| ------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `integration`       | The **Integration** sidebar item; `/sap-integration` shows "page not found"                 | SAP is out of scope for this phase              |
| `sap-status`        | Reports → Management exceptions: the **SAP failures** card and "Open SAP stock differences" | SAP is out of scope for this phase              |
| `stock-differences` | Inventory → Adjustments: the **Differences** panel and its Check differences button         | It compares our stock with SAP                  |
| `inventory-setup`   | Inventory: the **Set up** button (creates fixed starter warehouses)                         | Developer setup control, not for testers        |
| `production`        | Inventory: the **Production** tab                                                           | A list only; nothing can be done there          |
| `sample-order`      | Orders: the **New order** button                                                            | It added a fixed sample order                   |
| `cash-variances`    | Reports → Management exceptions: the **Cash variances** card                                | Empty placeholder: cash is not recorded         |
| `dsr-new-products`  | Daily sales report: the **New products** box                                                | Empty placeholder until Sunpride's list arrives |

Also changed for the beta (not switchable, because they are wording only):

- The page description no longer mentions SAP.
- When inventory is not set up, testers see "Inventory is not set up yet. Ask your
  administrator." instead of the Set up button.

Checked and nothing to hide:

- **PWA / mobile web**: the web app has no link to the retired PWA (ADR-004/010); `/mobile`
  is not a page.
- **Demo/seed controls**: apart from the sample order and inventory Set up above, no page
  calls a seed or demo function.
- Order status "sent to SAP" is shown as **Sent**, with no SAP wording.

## How to switch something back on

Either remove its key from `BETA_HIDDEN_FEATURES` in `src/config/beta.ts`, or, without a code
change, set `NEXT_PUBLIC_BETA_ENABLE` for the web build to a comma-separated list of keys
(or `all`) and rebuild:

```bash
NEXT_PUBLIC_BETA_ENABLE=integration,sap-status bun run build   # from apps/web
```

`NEXT_PUBLIC_*` values are fixed when the app is built, so a deployed app needs a rebuild.

## New for testers

- **Beta marker** at the top of every signed-in page ("Operations · Beta" under the logo and a
  Beta strip above the page).
- **Report an issue** in that strip on every page: opens a new issue with `Page: <path>`
  already in the description.
- **Help for testers** (`/help`, linked from the Beta strip, the sign-in page and access messages): sign-in steps,
  what to test, how to report an issue with a screenshot, and the Android download.
- **Android download link**: set `NEXT_PUBLIC_BETA_APK_URL` to the shared folder or file link
  (http/https only). When empty, the download section on `/help` is hidden. The iPhone app is
  not part of this release.

## Issue tracker access

Every signed-in role (including field sales, analyst and viewer) can open Issues, file an
issue, comment and attach screenshots (`issues.read`, `issues.write`). Changing status,
moving cards, assigning and editing an issue stay with the staff who did it before
(`issues.triage`: super admin, admin, operations, manager, approver); archive/restore stays
with super admin and admin (`issues.manage`). Testers cannot assign when filing. See
`docs/runbooks/ISSUE_TRACKER.md`.

## Sign-in for a new tester

1. An administrator invites the email address (Admin → Invitations) and, for every role
   except super admin and analyst, assigns an area (Admin → People).
2. The tester opens the sign-in page, chooses **Create account** with that email address.
3. If no area is assigned yet, every page shows "You have not been assigned to an area yet"
   instead of silently empty pages.
4. An email that was not invited, or access that was turned off, gets a clear message with
   **Sign out** and **Help for testers**, never an endless "Loading…".
