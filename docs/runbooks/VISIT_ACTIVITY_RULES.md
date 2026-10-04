# Visit intents and activity-form rules (AND-013)

A visit has one or more **intents** (its purposes for that store). Each intent has a
backend **rule** listing the activity forms it requires or offers. The field phone
downloads the rules with its day and builds the visit's activity checklist from them.

## Intents

`sell`, `collect`, `merchandise`, `audit`, `deliver`, `promotion`, `complaint`, `follow-up`.

- Planned visit: the intents come from the signed MCP slot and cannot be changed on the phone.
- Unplanned visit: the salesperson picks one or more before Start (Android requires at least one).

## Forms a rule can name

| Kind              | Phone form                                                         |
| ----------------- | ------------------------------------------------------------------ |
| `call_sheet`      | Annex C call sheet (needs an account sheet set up by the office)   |
| `merchandising`   | Display condition + optional action taken                          |
| `inventory_check` | Product from the account's call sheet, stock finding, optional qty |
| `price_check`     | Product from the account's call sheet, shelf price (PHP), matches? |
| `promotion`       | Program name + finding                                             |
| `note`            | Free-text note                                                     |
| `order_intent`    | Not captured yet (order capture is off); shown as unavailable      |

## Enforcement

- The phone will not queue a **completed** End until every required form it can capture is
  recorded. A **not productive** End (with a reason) needs no forms.
- A required form the phone cannot capture (no account products, unknown kind) is shown as
  "Not available on this phone" and does not block End.
- The server never refuses a queued End. On End it evaluates the rules in effect when the
  call started and stores `missingActivities` and `activityRuleVersion` on the visit for
  supervisor review (`visits/commands:detail` returns both).

## Changing a rule

`visits/activity_rules:set` — national master-data roles only (super admin, or an admin or
operations user at the national unit). Changes are future-effective, close the prior row and
never rewrite history; a change forces phones to download a fresh day.
`visits/activity_rules:current({ asOf? })` lists what is in effect.

Until Sunpride confirms a list, every intent uses the provisional defaults in
`packages/backend/convex/visits/activity_rules.ts` (`DEFAULT_ACTIVITY_RULES`).
