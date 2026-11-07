# IP-REFUND / IP-HOLD report

Branch `v2/ip-refund-hold`, worktree `/Users/jc/cnc/.worktrees/sunpride-refund-hold`, 6 commits on main `90f4a822`. Not merged, not deployed.

## Verdict

Ready for merge review. The full gate is green: Android assemble, unit tests, lint and androidTest assemble; API typecheck and the targeted refund tests; web typecheck and vitest; a double migration run on a copy of live data.

One finding changes how you read the API suite: 12 API test files fail on this lane DB, and the same 12 fail with the same test names on base `90f4a822`. Nothing new fails on this branch.

Known gaps are under Open items. The main one is that refund op payloads are not in the phone-ops wire fixture.

## Commits

| SHA | What |
|---|---|
| a28c4206 | Server: migration 0800, refund maths, credit-memo series, `store.refund.part`, `refund.record`, X/Z readings |
| 458d6560 | Van approval kind `refund`, store/van/math/seed tests, bundle opt-in |
| 1ee9c544 | Phone refund maths (shared fixture with office), approval codes, `RefundStore`, slip, wire opt-in |
| 52164e62 | Web van refund approval card, refund reasons hidden from stock pickers, capability 66, docs |
| f0a4ddaf | Android refund sheet (van + till), store refund op, hold and recall carts (Room v11), close blocks |
| a3bbae5c | This pass: gate fixes, v10→v11 migration test, refund/hold screenshot tests, supervisor PIN scroll, `reasons.js` typedef |

### Fixed in this pass

- **Real bug, caught by lint.** `RefundMath` used `BigInteger.TWO` (API 33) and `longValueExact()` (API 31), but minSdk is 29. Phones on Android 10–12 would have crashed on the first refund. Both are replaced with API-29-safe code, and `RefundMathTest` still passes (10 tests).
- **API typecheck.** `listReasonCodes` ignored the new `refund` option in its typedef. That was two tsc errors, now fixed.
- **Supervisor PIN pad.** On the till refund sheet the PIN pad appears below the footer after a supervisor is picked, so the cashier could not see it. The sheet now scrolls to the pad.
- **Wrapping.** The receipt number and credit-memo number no longer wrap onto a second line (18sp → 16sp).

## Decisions

- A refund is a credit memo, with its own number series.
- Refund and void are mutually exclusive on a sale. A voided sale cannot be refunded, and a refunded sale cannot be voided.
- Supervisor threshold is org-wide, default ₱500.00 (`refund_policies.supervisor_over_centavos`). **The ₱500 is a shipped default, not confirmed by Sunpride.** The office can edit it.
- The destination of the goods (sellable or damaged stock) comes from the reason code (`refund_destination`), not from the cashier.
- Cash goes out of the open till (store) or the van trip's cash (van). Other tenders go back by the original method.
- The credit-memo number comes from the phone's own range, so a refund works offline.
- Held carts are device-local (Room table `held_cart`). They hold no stock and no price. On recall every line is re-checked against the stock and prices the phone has then, and changes are shown in words.
- Van held carts are tied to the customer.
- A hold button was added to the cart. Charge stays the large button, and one tap never completes anything.
- Held-cart limits are 20 carts and 200 lines.

## Gate

All Android commands ran in `apps/van-sales-android`. The full log is in `~/.hermes/cache/scratch/rh/`.

| Step | Command | EXIT | Result |
|---|---|---|---|
| Android | `assembleDevDebug testDevDebugUnitTest lintDevDebug assembleDevDebugAndroidTest` | 0 | 661 unit tests, 0 fail; includes `HeldCartRulesTest` (8) and `RefundMathTest` (10) |
| Android (first run) | same | 1 | lint NewApi on `Refunds.kt`; fixed |
| androidTest on emulator | `VanMigrationTest` (all 6, incl. new `exportedV10MigratesToTheHeldCartTable`) | 0 | OK (6 tests) |
| androidTest on emulator | `RefundHoldScreenshotTest` | 0 | OK (11 tests, 15 PNGs) |
| API typecheck | `bun run typecheck` | 0 | clean after the typedef fix |
| API targeted tests (lane DB `pg-lane-refund-url`, `SP_LANE=refund`) | `bun test` per file | 0 | refund-math 11, refund-part-store 12, van-refund 7, store-fiscal-seed 2, capabilities 8, found-seams 18, phone-roundtrip-van 2, phone-roundtrip-store 2; 0 fail |
| API full suite | `bun run test` | 1 | 1199 pass, 15 fail, 12 files; **identical on base** (see below) |
| Web typecheck | `bun run typecheck` | 0 | clean |
| Web vitest | `bun run test` | 0 | 149 files, 1022 tests passed |
| Copy-of-live migration | `showcase-pre-storesetup-20261107-0214.dump` restored into a scratch DB | 0 | see Migrations |

- **Full API suite on base.** I ran the 12 failing files on a `git archive` of `90f4a822` against the same lane DB. The same tests fail in each file, so none are new here. The files are `board-cli`, `collections`, `distributors`, `fiscal`, `inventory`, `masters`, `mt`, `orders`, `sap-console`, `spec-integration`, `tpm-finance` and `target-cascade`. The causes look like lane DB state or environment: one fails with "Run with SP_LANE=opsboard", another with "Invoice tax lines need setup". I did not dig into them.
- **Web.** `@heroui-pro` is absent from both worktrees, so there was nothing to copy. Typecheck and vitest pass without it.

## Wire changes

All additions are opt-in. Older phones and apps never see them.

- **Van bootstrap.** A phone that sends `params.refunds=true` gets `policy.refunds`: reasons with destination, `supervisorOverMinor`, `approvalKey`, `made` (refunds already made on the trip), and its credit-memo number range.
- **Till bundle.** `refunds` is added when the request opts in. It carries the same fields plus `made` for the register's recent sales (capped at 500).
- **New op `refund.record`** (van): the refund id, sale id, picks by line index, reason, note, expected amount, and an 8-digit approval code when over the threshold. It is parked in the outbox like a sale.
- **New op `store.refund.part`** (till): the same payload, plus the supervisor PIN proof.
- **Van approvals.** The approval kind `refund` is new, with a web card (`VanRefundApproval`) that shows the code for the receipt, amount and reason.
- **Capability.** `van.refund.approve` is capability 66, held by super_admin, manager and approver.
- **Reasons.** `listReasonCodes` hides refund-only reasons (`refund_destination` set) from stock pickers unless asked with `refund: true`. Stock changes refuse them.
- **X/Z readings** now include refunds.
- **Phone-ops fixture.** `apps/api/test/fixtures/phone-ops.json` is unchanged. `PhoneRoundTripFixtureTest` compares the file byte for byte and passes. The refund ops are not in the fixture. The maths agree through the shared `refund-math-cases.json`, which both `RefundMathTest` and `refund-math.test.js` check.

## Migrations

- **Server `0800_sale_refunds.sql`.** It adds `inventory_reason_codes.refund_destination`, five seeded RF-* reason codes, `refund_policies`, and the refund and refund-line tables. Credit-memo series are seeded by `seedRefundSeries`. It does not rewrite any sale.
- **Copy-of-live test.**
  - I restored the newest dump into scratch DB `sunpride_scratch_refundhold_mig` on the local server.
  - The restore reported one benign error ("must be owner of extension vector", a comment on an extension).
  - The DB started with 178 migrations.
  - Run 1 applied exactly `0800_sale_refunds.sql`.
  - Run 2 printed "up to date".
  - Result: 179 migrations, 0 refunds, and 5 refund reason codes.
  - The scratch DB was dropped and confirmed gone. The live DB was never touched.
- **Android Room v10 → v11.** `held_cart` is a new table. `MIGRATION_10_11` is a plain `CREATE TABLE IF NOT EXISTS`. Schema `app/schemas/com.sunpride.van.storage.VanDatabase/11.json` is exported and committed. The new `VanMigrationTest.exportedV10MigratesToTheHeldCartTable` creates a v10 DB, migrates it, and validates the schema. It also checks the column list, that outbox bytes are untouched, and that an insert works.

## Shots

Emulator `SunprideLook720`, 720x1440, fixture data only. It was started on port 5580 and stopped by PID, and I used `adb -s emulator-5580` throughout. No physical phone was touched. The PNGs are in `/Users/jc/cnc/_plans/sunpride-inv-pos/shots/refund-hold/`, and each was checked by vision for clipping.

| File | What |
|---|---|
| `refund-hold-r1-picker-empty` / `r2-picker-chosen` | Refund picker, nothing chosen, then items chosen |
| `r3-confirm-approval` | Reason, note, over-₱500 supervisor approval |
| `r3b-supervisor-picked-pin` | Supervisor picked; the full PIN pad is visible above the footer |
| `r4-van-code` | Van: 8-digit supervisor code field |
| `r5-blocked` | Refund refused: trip already counted |
| `r6-done` | Refund saved: credit-memo number, cash to give back, slip reprint |
| `r7-slip` | Refund slip, 58mm / 32 columns, whole slip visible |
| `h1-held-list` / `h2-held-list-cart-in-use` | Held carts list; list when the current cart is in use (Recall disabled, message shown) |
| `h3-hold-dialog` / `h5-hold-dialog-from-cart` | Hold dialog |
| `h4-hold-button-in-cart` | Cart sheet with Hold next to Charge |
| `h6-held-badge-grid` / `h7-held-list-from-grid` | Held badge on the sell grid; list opened from it |

What vision showed:

- Nothing is clipped in any shot.
- Cards under the footer are the scrolling lists, not clipping. The picker, reasons, held list and approval block all scroll.
- The sell grid's category chips scroll horizontally. That is existing behaviour (`LazyRow`).
- When the "Held" badge shows, the search placeholder shortens to "Scan or sear…". This is cosmetic.

## Open items

- **Refund wire fixture.** Refund op payloads are not in `phone-ops.json`. The builders live inside Room-coupled stores, so adding them needs a small refactor to pure functions plus two API round-trip cases. Today the API tests build the payloads by hand, so a phone/API drift would not be caught by a fixture.
- **₱500 threshold.** It is a default, not confirmed by Sunpride. Ask them, then set it in `refund_policies`.
- **Held-cart "Held" badge** squeezes the search placeholder on a 720-wide screen. Cosmetic, left as is.
- **12 failing API test files on this lane DB** fail on base too. They need a clean seeded DB to tell what is environment and what is real.
- **Physical-phone proof not done.** The screenshots come from the emulator and fixtures, and the slip was previewed as text, not printed. Printing the slip on the Senraise printer is untested.
- **Not merged and not deployed.**
