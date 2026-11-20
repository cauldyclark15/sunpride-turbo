# Cash remittance — preparation for SP-0228

## Status and prerequisite

This is an implementation and acceptance checklist, not an available app feature or a record of money received. No Field app menu, receipt upload, Finance queue or weekly reconciliation integration is implemented by this document.

SP-0228 explicitly starts after **VAN-STOCK-WEEK (SP-0227)**. The SP-0227 preparation report says the weekly workflow is not implemented and is awaiting Sunpride's answers about the partial-loading cashier basis and stock reasons. Its preparation commit contains worksheets, a worksheet generator, tests and a runbook, not application changes. That commit is not in the starting tree for SP-0228.

Do not replace this prerequisite with the existing daily trip settlement or silently choose a weekly financial basis. Resume implementation after the weekly stock authority and cashier report are available. Building a separately usable remittance feature before that is a scope/sequencing change requiring JC's approval, not a question for Sunpride office staff on this issue.

## Confirmed client requirements

Source: `~/.hermes/attachments/SUNPRIDE_CORRECTIONS.md`, section 4, lines 37–47; client review on 20 November 2026, 38:16–39:55. The SP-0228 description supplies the form fields and Finance confirmation requirement.

- A salesman away from the depot can remit through Palawan or another remittance center.
- Record a **Cash remittance** activity with amount, channel, reference number and receipt photo.
- Finance can see the remittance and its receipt, then confirm it.
- The remittance counts toward the week's cashier reconciliation.
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

## Weekly reconciliation integration checklist

- Use the weekly stock record and cashier authority delivered by SP-0227; do not infer a weekly liability from a single day's POS total.
- Show unconfirmed remittances separately from confirmed amounts. Only independently confirmed entries can reduce cash still due in the cashier reconciliation.
- Support more than one remittance in a week and partial amounts. Confirming one must not require the week's final stock count to have happened already.
- Include each confirmed receipt exactly once. Retries, concurrent confirmations and repeated report reads must not duplicate its contribution.
- Keep outstanding cash, money remitted through centers and cash physically handed to the depot distinguishable. Do not double-credit an amount that appears in both a remittance and a later depot reconciliation.
- Do not treat a remittance as a new sale, a stock movement, a payment against an arbitrary customer invoice or proof that a disputed weekly liability is correct.
- Preserve the weekly report's own valuation and partial-loading rules. Do not settle SP-0227's unanswered requested-versus-served question here.
- Retain an auditable link from a weekly amount to its remittance, reference, receipt, submitter and confirmer. Any future correction must preserve the original facts rather than silently replace evidence or money.

## Smallest implementation proof after the prerequisite

All boxes below remain unchecked. These are future acceptance checks, not results.

- [ ] Create one clearly marked sample salesman, an independent scoped Finance reviewer and the smallest valid weekly stock record through the real delivered weekly workflow.
- [ ] In Field app > Remit cash, submit a positive amount, Palawan, a reference with leading zeroes and a real uploaded sample receipt image. Verify the persisted record and the privately served image, not just a mocked upload response.
- [ ] Submit another entry using another remittance center and a partial amount. Verify the first entry is unchanged and both belong to the intended weekly stock record.
- [ ] Verify Finance can list the pending records with amount, channel, reference, salesman and receipt; a missing or failed image is shown as unavailable, not substituted with a sample picture.
- [ ] Confirm one entry as the independent reviewer; read it back and open the weekly cashier report. The confirmed amount appears once; the unconfirmed second amount does not reduce cash due.
- [ ] Retry submission and confirmation unchanged, including a concurrent retry. Verify one record and one weekly contribution. Changed money, photo, reference or weekly link under the same request identity must not overwrite the original.
- [ ] Deny unrelated salesmen and out-of-scope readers both the record and receipt bytes. Deny sender self-confirmation and writes from a suspended/reassigned device or withdrawn assignment, including on replay.
- [ ] Refuse missing amount/channel/reference/photo, invalid amounts, a foreign or unstored receipt and a mismatched weekly record without partial business writes.
- [ ] Exercise remittance date, submission date and confirmation date across a week boundary. Read the original weekly report to verify no automatic reattribution.
- [ ] Reconcile a later depot cash hand-in and confirm there is no second credit for the same remittance.
- [ ] Run the specified API, web and Android checks for the areas actually changed. No phone installation or production write is authorized in the SP-0228 development work.

Use invented data only when visibly marked as sample. A sample workflow proves software behavior, not an actual Palawan transfer, a live Finance review or Sunpride acceptance.
