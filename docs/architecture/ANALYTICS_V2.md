# Management analytics contract (v2): read first, do not rename anything, report deviations

This contract is lead-owned and binding for lanes ANALYTICS (the server) and COCKPIT (the web). Every other lane may read it but must not change it. The product spec behind it is `~/cnc/_plans/sunpride-v2/70-owner-cockpit-plan.md`. Each management page answers one owner question. Every number compares to a target and to the prior period, shows a trend, drills down, and offers a next action. Exceptions come first.

## 0. Rules every endpoint follows

- **Reads only:** `GET /api/v1/analytics/<page>`, with the same auth and error envelope as `BACKEND_V2.md` §3. Scope is enforced on the server through `scopeUnitIds(actor)`. A client filter can narrow scope but never widen it.
- **Common query params:**

  | Param | Meaning | Default |
  |---|---|---|
  | `from`, `to` | Manila dates, `YYYY-MM-DD`, inclusive | month to date |
  | `unitId` | org unit | the caller's scope root |
  | `channel` | channel key | all |
  | `compare` | `prior` (the same-length window just before) or `ly` (same dates last year) | `prior` |
  | `format=csv` | on any endpoint that returns `rows`; returns RFC-4180 CSV with BOM and formula-prefix protection | JSON |

- **Common response header block:** every JSON response starts with
  `{"period":{"from","to","days","elapsedDays","remainingSellingDays"},"compare":{"from","to"},"scope":{"unitId","label"},"freshness":{"asOf":<epoch ms>,"devicesBehind":<int>,"oldestDeviceSyncAt":<epoch ms|null>},"demo":<bool>}`.
  `demo` is true when the data comes from the demo seed, and the web then shows a "Demo data" badge.
- **Kpi object:** `{"key","label","value":<number|null>,"unit":"php"|"pct"|"count"|"cases"|"minutes","target":<number|null>,"prior":<number|null>,"deltaPct":<number|null>,"status":"ok"|"watch"|"behind"|"unknown","definition":"<one plain sentence>"}`.
  - Money is **integer centavos**. The web formats it as ₱.
  - Percentages are 0–100 with one decimal.
  - `value:null` with `status:"unknown"` means "no data or not measurable". It is never shown as 0.
  - When no target exists, `target:null` and the web shows "Set target", linking to the Sales & targets page.
- **Status rule:** `behind` when attainment-to-date is below 90% of the pro-rated target, `watch` for 90–99%, and `ok` from 100%. These are our provisional defaults until Sunpride confirms them.
- **One definition per measure, shared by every endpoint:**
  - **Sales** = net value of order lines on orders whose status is not in (`draft`, `rejected`, `voided`), dated by the Manila order date. Van sales count on sale.
  - `stages` = booked, approved, posted (`posted`/`fulfilled`/`sent_to_sap`).
  - The ANALYTICS lane writes these definitions into `docs/architecture/KPI_V2.md` as formula plus source tables, and tests that Today, Sales and the drill rows reconcile to the centavo.
- **ExceptionItem:** `{"id","kind","severity":"high"|"medium"|"low","title","detail","subject":{"type":"agent"|"store"|"van"|"sku"|"territory"|"order","id","label"},"owner":{"profileId","name"}|null,"dueAt":<epoch ms|null>,"openedAt":<epoch ms>,"evidence":{…},"action":{"label","href"}}`.
  - `kind` is one of:
    - `behind_target`
    - `missed_stops`
    - `not_started`
    - `idle_agent`
    - `location_issue`
    - `van_unclosed`
    - `cash_variance`
    - `stock_variance`
    - `oos_hotspot`
    - `credit_breach`
    - `order_approval`
    - `mcp_approval`
    - `talk_sheet_overdue`
    - `per_diem_review`
    - `new_store`
    - `dormant_key_store`
  - `href` is a web path (for example `/workflows?order=<id>`).

## 1. Endpoints

| Endpoint | Answers | Body after the header block |
|---|---|---|
| `GET /api/v1/analytics/today` (date param `date`, default today) | How are we doing right now, and what needs me? | `kpis:[salesToday, mtdSales, balanceToSell, perDayNeeded, coverage, productiveCalls, collectionsToday, vansOut]`, `byChannel:[{channel,label,sales,target,attainmentPct,status}]`, `field:{counts:{noPlan,notStarted,inCall,done,idle},people:[{profileId,name,territory,status:"no_plan"/"not_started"/"in_call"/"done"/"idle",lastSeenAt,planned,visited,productive,sales}]}`, `vans:[{tripId,truck,seller,status:"loading"/"on_route"/"returned"/"settled"/"unclosed",salesCentavos,cashExpected,cashRemitted,variance}]`, `exceptions:[ExceptionItem ≤5, severity order]`, `trend:[{date,sales,target}]` for the last 14 days |
| `GET /api/v1/analytics/sales` (`groupBy=channel/territory/agent/category/sku/store`, optional `parent=<groupBy>:<key>` for drill) | Are we on target, and where are we behind? | `kpis:[sales, target, attainment, balanceToSell, perDayNeeded, orders, dropSize, linesPerOrder, ubo]`, `stages:{booked,approved,posted}`, `trend:[{date,sales,cumSales,cumTarget,cumPrior}]`, `rows:[{key,label,sales,target,attainmentPct,prior,deltaPct,orders,dropSize,ubo,status,drill:{groupBy,parent}/null}]` |
| `GET /api/v1/analytics/coverage` (`groupBy=agent/territory`) | Did my people do the plan? | `kpis:[compliance, missedStops, offPlanVisits, strikeRate, linesPerCall, timeInMarket, workWithDone]`, `weeks:[{weekStart}]`, `rows:[{key,label,planned,visited,compliancePct,missed,offPlan,productive,strikeRatePct,linesPerCall,firstCallAt,lastCallAt,timeInMarketMin,workWith:{done,required},weekly:[compliancePct/null],status}]` |
| `GET /api/v1/analytics/agent-day` (`profileId`, `date`) | What did this person do that day? | `person:{profileId,name,territory,position}`, `summary:{planned,visited,productive,sales,firstCallAt,lastCallAt,distanceKm}`, `timeline:[{at,kind:"check_in"/"check_out"/"order"/"collection"/"activity"/"gap",storeId,storeLabel,detail,amountCentavos/null,onPlan}]`, `trail:[{at,lat,lng}]` |
| `GET /api/v1/analytics/stores` (optional `status=active/dormant/new/lost/never`, `q`, `cursor`, `limit`) | Where is distribution weak? | `kpis:[universe, activeBuying, ubo, newStores, lostStores, dormant]`, `uboTrend:[{weekStart,ubo}]`, `rows:[{storeId,code,name,channel,territory,status,salesPeriod,salesPrior,deltaPct,lastOrderAt,lastVisitAt,skuCount,mustSellGaps,arBalance}]`, `next` |
| `GET /api/v1/analytics/store` (`storeId`) | Everything about this store | `store:{…master}`, `kpis:[salesPeriod, visitsPeriod, avgDrop, skuCount, osa, arBalance]`, `salesTrend:[{weekStart,sales}]`, `visits:[last 10]`, `orders:[last 10]`, `assortment:[{productId,code,name,lastBoughtAt,onShelf:true/false/null}]`, `suggestedOrder:[{productId,qtyCases,reason}]` |
| `GET /api/v1/analytics/stock` | Is the right stock in the right place? | `kpis:[stockValue, skusOutAtDepot, lowStock, daysCover, nearExpiry, badOrders]`, `locations:[{locationId,label,kind:"depot"/"truck"/"other",valueCentavos,cases}]`, `rows:[{productId,code,name,category,onHand:{cases,pieces,display},valueCentavos,avgDailySalesCases,daysCover,numericDistributionPct,oosStores,status}]` |
| `GET /api/v1/analytics/vans` (`date`) | Is every truck's stock and money accounted for? | `kpis:[tripsOut, salesCentavos, cashExpected, cashRemitted, cashVariance, stockVarianceCases]`, `rows:[{tripId,truck,seller,status,loadedCases,soldCases,returnedCases,stockVarianceCases,salesCentavos,cashExpected,cashRemitted,variance,voids,discountsCentavos,closedAt}]` |
| `GET /api/v1/analytics/money` | Are we collecting? | `kpis:[collectionsToday, collectionsMtd, arTotal, overdue, creditBreaches, heldOrders]`, `aging:{current,d1_30,d31_60,d61_90,d90p}`, `rows:[{accountId,code,name,channel,agent,balance,current,d1_30,d31_60,d61_90,d90p,creditLimit,lastPaymentAt,status}]` |
| `GET /api/v1/analytics/exceptions` (optional `kind`, `severity`, `ownerProfileId`, `cursor`) | What do I need to decide? | `counts:{<kind>:n}`, `items:[ExceptionItem]`, `next` |

Sales targets live in the ANALYTICS lane (tables come from schema `0114_analytics.sql`; add anything missing in that lane's own migration range):

- `GET /api/v1/targets?month=YYYY-MM&level=company|channel|territory|agent` returns `{month,level,rows:[{key,label,amountCentavos/null,setBy,setAt}],total}`.
- `POST /api/v1/targets/set` with `{month,level,key,amountCentavos}` requires `target.manage`. It is effective-dated and audited, and it publishes the topic `analytics`.
- `POST /api/v1/targets/import` with `{month,rows:[{level,key,amountCentavos}]}` is all-or-nothing and returns the row errors.

Realtime: the topic `analytics` is invalidated after any write that changes the figures (orders, visits, van, collections, targets). It is coalesced to at most one notification every 5 seconds per process.

## 2. Web (COCKPIT lane)

- Navigation becomes the owner's questions, in order:
  1. Today
  2. Sales & targets
  3. Coverage & people
  4. Stores
  5. Products & stock
  6. Vans & cash
  7. Money
  8. Decide (exceptions inbox)
  9. Live map
  10. Work, a group holding the workflow pages: Orders, Approvals, Coverage plans, Supervision, Call sheets, DSR, DAR/ROAR, Training, Inventory, Imports
  11. Issues
  12. Setup (Admin, Master data)
- **One shared period/scope bar per page,** with state in the URL (`?from&to&unitId&channel&compare`).
- Shared kit in `apps/web/src/components/cockpit/kit/**`:
  - KpiCard (value, target bar, delta vs prior, status colour, definition tooltip)
  - TrendChart (in-house SVG, no new dependency)
  - DrillTable (sortable, clickable rows, CSV export via `format=csv`, print)
  - ExceptionList
  - FreshnessNote
  - DemoBadge
  - EmptyState, which separates unknown, zero and needs-setup
- Each page is built against this contract with mocked fetchers in tests.
