# Cash remittance (SP-0228)

## Status and scope decision

Built standalone. SP-0228 originally started after the weekly truck stock card (**VAN-STOCK-WEEK, SP-0227**), which is waiting on Sunpride's answers. JC's lead session authorized building remittance capture and the Finance queue **now**, and linking confirmed remittances to the weekly cashier reconciliation later in SP-0227. Until then a remittance is not counted in any weekly figure.

## Where

- **Field app → More → Remit cash** (people with Selling on, and the owner). Amount (₱), Sent through (Palawan Express, Cebuana Lhuillier, GCash, Bank deposit, Other + name), Reference number, Date and time remitted, Receipt photo (required), Note (optional). Saved on the phone first and sent by itself through the normal sync (op `remittance.submit` in the shared domain outbox), so it works without signal.
- **Web → Work → Cash remittances** (`/remittances`). Opens on "Waiting for Finance". Filter by dates, branch, salesman and status; View receipt; Confirm or Reject (reason required); Download CSV.

## How it is stored and checked

- `field_cash_remittances` (migration `0840_cash_remittances.sql`): salesman, the salesman's branch at submission, device, amount in centavos, channel (+ other name), reference, remitted time, submission time, note, receipt file (`files`, purpose `remittance-receipt`), status `submitted` / `confirmed` / `rejected` (+ reason, reviewer, review time). Submit, confirm and reject each write `audit_logs`.
- Retry safety: op receipts (phone op id) plus the remittance id. The same facts sent again are the same record; changed facts under the same id are refused (`idempotency_conflict`). The phone's `deviceTime` stamp is not part of the facts.
- Capabilities: `remittance.submit` (owner, sales; the server also requires Selling on), `remittance.read` (owner, admin, operations, manager, approver, analyst), `remittance.review` (owner, admin, operations, approver = Finance). Reads follow the stored branch and the reader's current scope: managers see their branch and below, national office roles see all. Out-of-scope rows and receipts answer "not found". Nobody reviews their own remittance. A decision is final; repeating the same decision is harmless.
- Receipt JPEG: up to 64 KiB, longest side 1024 px (≤ 1 MP), digest-checked and decoded on the server; served privately (`/api/v1/remittances/:id/receipt`, `no-store`).
- API: `GET /api/v1/remittances?from&to&unit&salesman&status`, `POST /api/v1/remittances/:id/confirm`, `POST /api/v1/remittances/:id/reject {reason}`.

## Confirmed client requirements

Source: `~/.hermes/attachments/SUNPRIDE_CORRECTIONS.md`, section 4, lines 37–47; client review on 20 November 2026, 38:16–39:55. The SP-0228 description supplies the form fields and Finance confirmation requirement.

- A salesman away from the depot can remit through Palawan or another remittance center.
- Record a **Cash remittance** activity with amount, channel, reference number and receipt photo.
- Finance can see the remittance and its receipt, then confirm it.
- The remittance counts toward the week's cashier reconciliation (SP-0227, not yet).
- The client said cash should be remitted the same day or by the next day. No cash threshold was set.

Do not invent an amount threshold, processing fee, automatic approval, late-entry lockout or a rule limiting remittance centers to Palawan. Display the same/next-day guidance without pretending software can attest when the center actually received the money.

## Existing daily hand-in is not this feature

The current daily path is intentionally different:

- `packages/db/migrations/0241_van_cash_handin.sql` defines one `van_cash_remittances` row per trip and per cash count. It has a received amount, receiver and reference, but no receipt photo, channel or weekly stock link.
- `apps/api/src/domains/van/commands.js`, `remitCash`, requires a separate office receiver, an existing seller cash count and an amount equal to the effective count. It records cash already received by the office. It is not a salesman submission to a remittance center.
- `apps/web/src/components/van/cash-hand-in.tsx` is the corresponding office cash hand-in form; it cannot capture the requested field activity or photo.
- `apps/api/src/domains/van/settlement.js` manages trip settlement. A daily trip is not the client's Monday-to-Saturday weekly stock accountability.
- `apps/api/src/domains/visits/evidence.js` binds visit photos to an owned visit and active bound device. It is useful evidence-authorization context, not an existing general-purpose remittance receipt attachment. Do not reuse a visit photo by inventing a visit or dropping its ownership checks.

Preserve these existing paths until the weekly workflow explicitly integrates them. In particular, a remittance must not also be recorded as a second depot receipt for the same money.

## Prepared capture checklist

The following labels describe intended business facts, not a finalized storage or wire contract. Resolve the weekly link from the delivered SP-0227 model rather than introducing an unrelated second definition of a week.

| Fact                         | Capture or derive                     | Acceptance requirement                                                                                             |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Salesman                     | Derive from authenticated person      | Never trust a selectable replacement sender.                                                                       |
| Branch                       | Derive from authorized assignment     | Finance visibility must follow the stored record and current authorized scope.                                     |
| Weekly stock record          | Select from authorized weekly records | Retain the exact governing week; a next-day or later upload must not silently move a remittance into another week. |
| Amount (PHP)                 | Salesman enters                       | Positive exact centavos; reject invalid input instead of silently rounding. No minimum business threshold.         |
| Channel                      | Salesman enters                       | Support Palawan and other remittance centers; do not invent a closed client channel list.                          |
| Reference number             | Salesman enters                       | Required; preserve leading zeroes and meaningful punctuation.                                                      |
| Remitted on                  | Salesman records                      | Distinguish the claimed remittance date from actual submission and Finance confirmation times.                     |
| Receipt photo                | Salesman captures/attaches            | Required, durably stored and privately readable by the sender and authorized Finance reviewer.                     |
| Submission identity and time | System derives                        | Stable retry identity and audit attribution; a retry cannot create another remittance.                             |
| Finance confirmation         | Independent authorized reviewer       | Store reviewer and time; a sender's submission alone is not a confirmed financial receipt.                         |

Keep visible statuses limited to what is true: waiting to send on the phone, submitted for Finance review, or confirmed after the office actually confirms. A photo that has not reached protected storage is not available to Finance. Do not display “received” or “confirmed” merely because a transport request succeeded.

## Weekly reconciliation integration checklist (SP-0227, still to do)

- Use the weekly stock record and cashier authority delivered by SP-0227; do not infer a weekly liability from a single day's POS total.
- Show unconfirmed remittances separately from confirmed amounts. Only independently confirmed entries can reduce cash still due in the cashier reconciliation.
- Support more than one remittance in a week and partial amounts. Confirming one must not require the week's final stock count to have happened already.
- Include each confirmed receipt exactly once. Retries, concurrent confirmations and repeated report reads must not duplicate its contribution.
- Keep outstanding cash, money remitted through centers and cash physically handed to the depot distinguishable. Do not double-credit an amount that appears in both a remittance and a later depot reconciliation.
- Do not treat a remittance as a new sale, a stock movement, a payment against an arbitrary customer invoice or proof that a disputed weekly liability is correct.
- Preserve the weekly report's own valuation and partial-loading rules. Do not settle SP-0227's unanswered requested-versus-served question here.
- Retain an auditable link from a weekly amount to its remittance, reference, receipt, submitter and confirmer. Any future correction must preserve the original facts rather than silently replace evidence or money.

## Proof status

Automated: `apps/api/test/remittances.test.js` (create, idempotency, validation, Selling off, scope, receipt access, confirm/reject), `apps/web/src/components/remittances/remittances.test.tsx`, `apps/field-android/.../remit/RemitCashTest.kt`. Not yet done: a phone pass on the test phone and Sunpride's own trial. The weekly-link checks above wait for SP-0227. Use invented data only when visibly marked as sample.
