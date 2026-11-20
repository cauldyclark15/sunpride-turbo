# Plan vs actual — store-visit report (SP-0226)

Open Reports > Plan vs actual. Choose an inclusive Manila date range (up to 93 days, through today), then a salesman, branch, territory, territory type or customer group. Select Show report. Open a day to see its stores, approved activities, visit states and recorded activity kinds. Export CSV downloads every matching day, not just the open day.

## What the figures mean

- Planned stops are approved/active MCP outlet-visit slots, including historical slots from a superseded version only before its replacement boundary. Draft/submitted plans do not count. An approved stop without a generated visit still counts as planned.
- Visited stops are distinct planned stops with an accepted closed field visit, linked by its generated planned-visit identifier, salesman, date, store and source branch. A same-store unplanned visit does not count as following the plan. Replays cannot add another execution for the same planned stop.
- Visit completion % is visited planned stops / planned stops. It is displayed separately from plan followed %.
- Plan followed % is planned stops with a completed visit AND every approved store activity marked done / planned stops. A stop with no planned store activities needs only its completed visit. No planned stops gives “No plan”, not 100%.
- Store activities use the latest received tick/untick on the completed visit. Only the planned activity identifiers earn activity completion credit; unrelated notes/forms never stand in for a planned collection/countering/stock-count task. The displayed activity names are frozen approval-time names. These ticks are self-reported, not cash, productive-call or manager-verification evidence.
- Missed stops are past-date planned stops without an accepted closed visit. Today's unfinished stops remain “Not yet completed”; a closed visit with missing tasks is “Activities unfinished”. Open, pending-review and rejected visits remain visible in the drill-down but earn no completion credit.
- Unplanned visits are recorded executions that do not match an included approved stop. They are shown separately, including their open/review state, and never improve either plan-following percentage. Total completed visits includes accepted closed unplanned visits; it is not the same as visited planned stops.
- Stores are distinct store identities across the selection. Days count salesman/date pairs. Actual store/day counts include accepted closed unplanned work; planned counts do not.
- The previous period is the immediately preceding equal number of calendar days under the same filters. Daily rows show exceptions first and allow inspection of each day's counts and percentage. Non-store MCP work is outside this store-visit report.

## Attribution and access

Signed store names, route labels and planned activity lists remain authoritative after master-list changes. Territory type and customer group are explicitly labelled current master data because older signed snapshots do not contain these fields. Branch is the source plan/visit branch; selecting a branch includes its effective subtree even for a cross-scope administrator.

Every source read also requires the salesman's current permitted assignment, the stored plan/visit branch and the store's current persisted owner/custodian to be in scope. Salesmen see only their own work. Withdrawn scope hides historical details and filter choices too. The report reads one repeatable-read, read-only snapshot and never writes business data.

The report refuses more than 10,000 planned rows, 10,000 visits or 100,000 activity records across current plus prior periods, rather than returning a partial percentage/export. Narrow the dates or choose a salesman when prompted. Unsynced phone work is not included until received.

## Evidence boundary

Automated proof uses a disposable SP-0226 test database: public planning, approval and activation plus signed simulated-device check-in, task tick/untick and checkout, followed by authenticated report reads. Supplemental sample mutations cover denied/review states, source/store/person scope withdrawal and prior-period calculations. The exact report JSON can be passed to the web component/export tests using SP_PLAN_ACTUAL_PROOF. None of this is a physical-phone, client-data, or production-site proof.
