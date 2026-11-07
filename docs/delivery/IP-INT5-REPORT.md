## Verdict

DONE. Branch `v2/ip-int5` (worktree `/Users/jc/cnc/.worktrees/sunpride-ip-int5`, from main `90f4a822`) holds both lanes plus one interplay fix. Gate is green with no new failures against base. Beta.32 APK is built and signed. Not merged to main, not deployed, not installed on any phone.

Two things to know:
1. **Real package for web.** Web vitest needs the real `@heroui-pro/react`. The one the install gives is a stub, so I copied the real one from the hh2 worktree into this worktree's `node_modules` (not committed).
2. **Cap on phones.** The phone only gets the weekly limit when the device has a POS mode row (store, or van with a mode record). A van phone without one gets no limit, sells as before, and the server records any overage in Decide. This is the cap lane's design, not changed here.

## Merge commits (on `v2/ip-int5`)

| SHA | What |
|---|---|
| fast-forward to `83fb1f67` | `v2/ip-refund-hold` (no conflict, main was its base) |
| `d1ed95e6` | Merge `v2/ip-scpwd-cap` (5 conflicts, below) |
| `236e5dbb` | Interplay fix: partial refund gives back weekly limit (migration 0812) + tests |

## Conflicts and resolutions (all "keep both")

| File | Resolution |
|---|---|
| `apps/api/src/domains/storepos/operations.js` | both imports (`refundPart`, `assertLegacyZAllowed`) |
| `apps/api/src/domains/van/projection.js` | `params()` keeps both opt-ins: `refunds` and `privilegeCap` |
| `Models.kt` (`VanPolicy`) | both fields `refunds` and `privilegeCap`, comma fixed |
| `VanBootstrapCodec.kt` | both decoded: `refunds` at top of policy, `privilegeCap` inside `storePos` |
| `VanSyncClient.kt` | bootstrap params ask for both: `.put("refunds",true).put("privilegeCap",true)` |

The cap report also listed `decide/index.js`, `navigation.ts`, `operations-workspace.tsx` and `test/harness.js`. Git merged those without conflict. The web typecheck and 150 vitest files pass, so both nav entries and the Decide kinds coexist.

## Interplay fixes

1. **Partial refund gives back its share of the weekly limit** (server, with tests).
   - New append-only table `privilege_cap_releases` (migration `0812_privilege_cap_refund_release.sql`), one row per refund, guarded by `fiscal_immutable()`.
   - `releaseCapForRefund` / `capReleaseFor` in `fiscal/privilege-cap.js`, called from `insertRefund`, so store (`store.refund.part`) and van (`refund.record`) both use it.
   - Share = (regular price of the discounted lines refunded so far) / (regular price of all discounted lines) × the sale's `applied_gross`. Rounded cumulatively half up, so the refunds of one sale give back exactly what it used and never more. Lines without a privilege discount give nothing back.
   - `usedThisWeek` and `capBundle` now subtract releases. Voids keep working as before (voided invoice not counted).
   - Tests:
     - `refund-part-store`: a senior sale, refund one of two pieces (used drops by half, phone bundle shows the same figure), then the last piece (used 0). Releases sum to what was applied, and the table refuses updates.
     - `privilege-cap-van`: the same calculation on a real van-shaped receipt (PWD sale, 1 of 2 pieces gives half, the whole line gives all).
   - `refund-part-store` Z-reading test updated for the 2 extra refunds (5,571 more, 9 refunds).
   - Not done: the phone does not subtract its own offline refunds from its local "used". It stays conservative until the next bundle, which can show up as a `short` flag in Decide.
2. **Opt-ins stay opt-in; v1 strict schema untouched.** New tests:
   - `privilege-cap.test`: store bundle with `{}`, `{refunds}`, `{privilegeCap}`, `{both}`. Each key appears only on its own ask, asking for both adds exactly `storePos.privilegeCap`, and the policy key set equals the refunds-only bundle. `van-wire-v1-policy-keys.json` (`validatedKeys`, `strippedBeforeValidation`) is unchanged and neither key is in it.
   - `van-refund.test`: a van pull asking for both has the same top-level policy keys as the refunds-only pull. A cap-only ask does not switch refunds on.
3. **Room chain is linear.** The cap lane added no Room version. `VanDatabase` is `version = 11` (refund lane, `held_cart`), schemas `1.json` … `11.json`, `VanMigrationTest` (6 tests incl. `exportedV10MigratesToTheHeldCartTable`) passes on the emulator. No renumbering needed.
4. **Build number 32.** The number is `SUNPRIDE_BETA_BUILD` at build time, not in the repo. I set it to 32 in `apps/van-sales-android/local.properties` (ignored by git; copied from the refund-hold worktree) and also exported it for the build. The APK shows `versionCode='32' versionName='1.0.0-beta.32'`.

## Gate

Logs and `EXIT=` lines are in `/Users/jc/cnc/_plans/sunpride-inv-pos/reports/int5-gate/`. Lane DB: `sunpride_lane_int5` (key file `~/.sunpride-keys/pg-lane-int5-url`), made by hand with the lane-setup commands, no extra worktree.

| Gate | Result |
|---|---|
| Migrate from scratch | EXIT=0, 0001 … 0811 + 0812 (`migrate1.log`). Duplicate prefixes only 0560 and 0579, same as main |
| `packages/db` `migrate.test.js` + `schema.test.js` | 14 pass (`db-tests.log`) |
| API tests, every file alone, `--timeout 60000` (`api/`) | 158 files. 1223 pass / 15 fail in 12 files |
| API failures vs base `90f4a822` (`git archive`, own lane DB, `base/`, `api-rerun/`) | **New failures: 0.** 11 files fail with identical test names on base and branch (board-cli, collections, distributors, fiscal, inventory, masters, mt, orders, sap-console, spec-integration, tpm-finance). `analytics-performance` p95 test fails on both (35 s / 65 s under load), thresholds untouched |
| `apps/api` typecheck | EXIT=0 clean (`api-typecheck.log`) |
| Web `tsc --noEmit` | EXIT=0 (`web-tsc.log`) |
| Web vitest | 150 files, 1034 tests pass (`web-vitest.log`) |
| van-sales-android `assembleDevDebug testDevDebugUnitTest lintDevDebug assembleDevDebugAndroidTest` | BUILD SUCCESSFUL, EXIT=0, 674 unit tests (2 skipped, 0 failed), lint clean (`android-van-gradle.log`) |
| field-android, same four tasks | BUILD SUCCESSFUL, EXIT=0, 577 unit tests (1 skipped, 0 failed) (`android-field-gradle.log`) |
| Emulator (mine, `SunprideLook720`, port 5582, PID 61228, stopped by PID) | `VanMigrationTest` OK (6), `RefundHoldScreenshotTest` OK (11), `PosV2ScreenshotTest` OK (15) |
| Copy of live | Newest dump `showcase-pre-storesetup-20261107-0214.dump` restored into scratch DB (4 benign "must be owner of extension" errors). 178 migrations before. First migrate applied `0800`, `0810`, `0811`, `0812` only. Second run "up to date". 182 after, 17 devices kept, 5 refund reasons, `privilege_cap_releases` empty. Column list identical to a from-scratch migrated DB. Scratch DB dropped (`copy-of-live-migration.log`) |

Gate notes:
- The first emulator attempt (headless, software GPU) hit a "systemui not responding" dialog under machine load (load average about 19) and 2 espresso tests failed on window focus. I killed only my own emulator and run, restarted it with the host GPU, and all three classes passed. Both runs are in the gate folder (the failed run's log was overwritten by the passing one).
- Only the emulator on port 5582 was used (`adb -s emulator-5582`). Two physical phones were attached and were not touched.
- No-op detail: I sent one `pkill -f run-files.zsh` at the start to stop my own hung test run. It matched only my own script.

## Migrations in order (new on top of main)

1. `0800_sale_refunds.sql` (refund lane)
2. `0810_privilege_weekly_cap.sql` (cap lane)
3. `0811_legacy_z_gate.sql` (cap lane)
4. `0812_privilege_cap_refund_release.sql` (this integration)

Android Room: v10 to v11 (`held_cart`), one step.

## Wire changes (all opt-in)

From the two lanes (see their reports for detail):
- Refund: `params.refunds` gives `policy.refunds` (van) and `storePos.refunds` (till). New ops `refund.record` and `store.refund.part`. Van approval kind `refund`. Capability 66 `van.refund.approve`.
- Cap: `params.privilegeCap` gives `policy.storePos.privilegeCap`. `discountClaim.capBasis` on `sale.record` / `store.sale`. Headers `x-app-version-code` / `x-app-version-name` on sync (beta.32 onwards). New office routes `fiscal/privilege/cap`, `storepos/legacy-z`, `storepos/legacy-z/gate`. Decide kind `privilege_cap`.

New in this integration: none on the wire. The release is server-side only.

Beta.32 asks for both in one bootstrap. A server without either feature ignores the param, so a new phone on an old server gets neither.

## APK

- Path: `/Users/jc/cnc/_releases/sunpride/van-beta/1.0.0-beta.32/sunpride-van-1.0.0-beta.32.apk`
- sha256: `edbcd14bcf28ae1d44a5187035764766748be83d18035c6790c2ada45c548a2c` (also in `...apk.sha256`)
- Package `com.sunpride.van.beta`, versionCode 32, `https://sunpride.cauldnclark.com` baked in.
- Signed with the existing beta key. The signer SHA-256 `71d47cc5…9190e46` is the same as beta.31's. The script's checks (apksigner, not debug-signed, not debuggable) passed. Log: `apk-build.log`.
- Built from the tree at `236e5dbb`. Not installed anywhere.

## Open items

- Phone-side refund does not return limit locally until the next bundle (see fix 1); an offline day can show `short` flags in Decide.
- A device with no POS mode row gets no `privilegeCap` in its bundle (see Verdict point 2). Confirm that every van phone has a mode row, or the limit never reaches vans.
- Carried over from the lanes: PHP 2,500 default limit vs 1,300 (needs the accountant), the 20% + VAT-exempt regime applied to every line vs the 5% BNPC regime (biggest legal risk), PHP 500 refund supervisor threshold is a default, refund op payloads are not in `phone-ops.json`, 12 API test files fail on lane DBs on base too (need a clean seeded DB to tell environment from real), no real-phone proof, slip printing untested on the Senraise printer.
- Beta.26-31 phones show as "Build not reported yet" in the old-build report until they take beta.32.
- The live checkout has uncommitted edits (`packages/db/seed/kickoff-demo*.js`, `.dsh-shots/`). They are not mine and I did not touch them.
- Not merged to main, not deployed.
