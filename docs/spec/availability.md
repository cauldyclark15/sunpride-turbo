# Retail execution and availability — F-211–F-220

## F-211 — Versioned must-stock assignment

Owner question: which stores must carry each SKU, and what should the next call achieve?

Trade Marketing lives in Setup → Admin → Trade Marketing (`/admin?section=availability`). Draft → bulk preview → publish freezes the audience, product references, minimum proposals, source reference and effective interval. Outlet override wins over channel/sub-channel/class specificity, then priority. Equal precedence is a setup error, not an arbitrary winner. A replacement closes the preceding version prospectively. Operational policies win over matching sample policies. Sample MSL/focus policies apply only to marked sample outlets.

`availability_releases` is an adapter for published execution policy, not a new product or taxonomy master. `masters.js` marks SEAM(MASTERS): replace the F-017 framework reader and legacy outlet taxonomy projection at integration, retaining the resolved immutable execution snapshot. Existing `products`, `units_of_measure`, product barcodes, outlet ownership and territory tables remain authoritative.

## F-212–F-213 — One in-call step and editable OOS order

The existing field call and van sale screen embed the same Compose `RetailAvailabilityStep`; there is no parallel call flow. SEAM(CALLFLOW) exposes `availabilityStepComplete` and `requireAvailability` for the engine's configured completion boundary. Field End and van checkout call that guard until the engine lands.

Every frozen required line must be explicitly present or absent. Scan resolves one unique MSL barcode/code; ambiguous scans require a tap. Not-checked remains unmeasured. Field saves checklist + explicit absent-line acceptance/dismissal + editable order draft in one encrypted Room transaction. Van saves checklist + decisions in one encrypted Room transaction and prepares an editable sale cart without posting a sale. Whole base quantities and the downloaded MSL are revalidated at the transaction boundary. A repeated save cannot create a second draft or proposal. A dismissed proposal has zero quantity and no order binding; an acceptance records the initial chosen quantity/order key. Later ordinary draft/cart edits remain possible and do not rewrite the immutable initial decision.

The field wire materializes `@checkin:<request>` only after durable check-in acknowledgement. Upload validation compares device capture with device Start/End, not delayed server receipt time. Van evidence operations join the same trip operation audit authority used by close manifests. Authorization is repeated against persisted phone, person, current owner and trip state. Current-scope withdrawal wins over historical availability reads.

## F-214–F-215 — One denominator and distinct measurements

SEAM(MASTERS): a validated F-011 census supplies `availability_universes`. Publication freezes the eligible physical outlet list, turnover weights and validation/source references. Provisional/inactive stores are refused. Operational census snapshots take precedence over sample census snapshots. Current ownership and actor scope filter both denominators and source facts.

Numeric distribution = stocking outlets / that same universe. Weighted distribution = sum of stocking outlets' turnover weights / all universe turnover weights. Shelf absence with positive back-room stock is stocked for distribution but absent for OSA. Missing back-room counts on an absent shelf remain unknown. Missing/stale observations, stale census, or missing weights produce null, never invented zero/equal weights; confirmed lower bounds remain distinct.

Products & stock retains the historical purchasing ratio as **Buying reach**, not “Stores carrying” or ND. Its API field is `buyingReachPct` (formerly the misleading `numericDistributionPct`); the calculation remains distinct from validated-universe stocking distribution. Deploy the matching web and API changes together.

Stocked SKU depth is independent of bought SKU depth. Order strike = completed physical calls producing non-void captured orders / completed physical calls. Lines per call uses those exact calls and linked lines. A van checkout is one physical call, not one call per SKU. Source orders additionally require current creator and stored location authorization; a shared customer/outlet link is not a source-order access key.

## F-216 — New-product launch cohort

Published launches freeze product references, target outlets, source and dated cumulative build targets. The tracker shows each scoped target's first captured non-void order date, repeat-order flag and build curve versus plan. Unknown first orders remain unknown. A narrowed scope is disclosed instead of silently comparing regional actuals to an unqualified national plan.

The additive sample seed retains a cold-start cohort and adds a purchase-history cohort drawn from already marked canonical sample van receipts. This demonstrates first orders, repeat purchases and targets with no order yet without manufacturing financial transactions for the chart. Rerunning the seed never rewrites an existing published cohort.

## F-217 — Shelf, back room and offtake

The in-call step captures shelf and back-room integer base quantities. Optional interval deliveries and returns must be explicitly counted; blank is unknown, not zero. Offtake conserves stock: opening shelf + opening back room + interval deliveries − returns − closing shelf − closing back room. Missing inputs, non-increasing times or inconsistent negative results remain unknown. The resulting bounded interval is an input to the next shared recommendation, not a claim that orders equal consumer offtake.

## F-218–F-219 — One explainable recommendation service

`availability/rules.js:suggest` is the canonical calculator. The authorized call projection supplies measured offtake or independently scoped attributed order history, stock, effective cover-day policy, MSL minimum, matching focus objective and active promotion uplift. Web store recommendations and field/van bootstrap use it; the legacy non-MSL ICO adapter delegates calculation to it and retains its existing response shape. Native clients consume frozen reasons and quantities and apply the published absent-line minimum offline; they do not calculate forecasts or prices.

Focus audiences support territory, channel, sub-channel, class and explicit outlets. Published objectives appear beside the SKU during the existing call. Prices, credit and inventory posting remain their existing governed authorities.

## F-220 — Existing Coverage cockpit, not another dashboard

`/coverage-people` keeps one period, comparison and current organizational/channel scope. It adds validated, covered and SAP-billed universes, stocking ND/WD, MSL OSA and completeness, and approved-period visit-frequency achievement. Universe outlets meeting planned physical-call frequency form the frequency numerator; outlets with an approved-period planned call form the denominator. Existing plan-specific MCP adherence remains separate through SEAM(COVERAGE). Rows drill to SKU/store gaps, stocked versus bought depth, calls versus plan and next actions. Store OSA uses the same present/required frozen-check definition.

SEAM(SAP): SAP invoice evidence must supply billed-universe facts. Local order captures and van receipts are deliberately not relabelled as SAP billing; the card says not measured until that feed lands.

## F-211–F-220 — Sample data and operations

Migration: `0460_availability.sql` only. The additive `seedAvailability` hooks into the existing seed CLI and daily advance, marks every sample release, snapshot, check and census in `sample_data_rows`, and never resets operational data. Sample content is explicitly invented: three must-stock products, minimum quantities, one focus objective, dated launch build targets and turnover weights. Existing sample policies remain immutable on rerun. Measurement reads prefer real policy/census authorities over sample fallbacks.

## Needs Sunpride — F-211–F-220

Real MSL families/precedence, channel/sub-channel/class taxonomy and the validated census/turnover-weight source; launch cohorts/build targets; key-SKU stock-count instructions; approved cover/freshness windows; focus objectives; promotion and SAP invoice/credit/price feeds. The marked sample defaults keep the implemented workflow demonstrable while these inputs are pending. They are our design defaults, not claims about Sunpride's current operations.

## iOS parity later — F-212–F-219

iOS is paused and unchanged. It will need the shared snapshot DTO, call-step checklist/scan, explicit interval counts, encrypted atomic checklist/proposal/draft queue, completeness guard, new event kinds and the same backend reasons. No paused iOS runtime/config changes were added.
