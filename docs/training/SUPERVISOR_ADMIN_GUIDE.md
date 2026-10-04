# Supervisor and administrator guide — Sunpride sales system (web)

Tracker: SP-0015 (QSR-017), milestone `12 · Field sales pilot (Cebu)`.

This guide is for the people who run the field team from the web app: supervisors and
sales managers, sales admins (operations) and administrators. It covers the Master
Coverage Plan (MCP), approvals, territories and routes, stores (outlets), phones, watching
the field day, and handling exceptions.

Salespeople use the field app on their own phones; that app has its own guide.

## How to read this guide

- Words in **bold** are exactly what you see on the screen (tab names, buttons, card
  titles, statuses). `apps/web/src/lib/user-guide.test.ts` checks every bold label against
  the app, so the build fails if a screen label in this guide stops existing.
- `Field › Coverage` means: click **Field** in the left menu, then the **Coverage** tab.
  The web address is shown in brackets, e.g. (`/sales-force`).
- Dates and times are Manila time. The selling day closes at 10:00 PM. Monday to Saturday
  are selling days (Saturday is a collection day for key accounts and still counts).
- Rules marked "Client rule" come from Sir Francis's memo of 20 January 2026 and the
  2 October 2026 call. Where they differ, the call answers win.

## Contents

1. Roles: who can do what
2. Your month, week and day at a glance
3. Master Coverage Plan (MCP): writing a plan
4. Reviewing, returning and approving a plan
5. Backup approver when the supervisor is away
6. Activating a plan and changing an approved plan
7. Coverage views: calendar, map, route, workload, deadlines, export
8. Plan exceptions (before approval)
9. New-store approvals
10. Organization units, people and teams
11. Territories and routes
12. Outlets, GPS pins and route order
13. Phones: suspend, reinstate, revoke, lost phone
14. Watching the field day (Supervision)
15. Field exceptions: deciding location evidence
16. Coaching: Work-With, Talk Sheet, trainer forms
17. Reports a supervisor reads
18. Order approvals
19. Troubleshooting
20. Not in the system yet / open client questions

## 1. Roles: who can do what

Every person has one app role. The role decides what they can do. Their position (job
title, e.g. KAS, RDS, DS) is separate and decides their call targets and routine. Their
organization unit decides whose data they see: a person only sees their own unit and the
units under it.

| Role on screen    | Who it is for           | Main things they can do                                                              |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| **Super admin**   | System owner            | Everything, across all units. Cannot approve their own work.                         |
| **Administrator** | National / regional IT  | Users, units, teams, territories, routes, outlets, phones. Cannot approve MCPs.      |
| **Operations**    | Sales admin             | Routes, outlets, outlet assignments, imports, outside-call POs.                      |
| **Sales manager** | Supervisor or manager   | Approves MCPs, new stores and field exceptions; verifies pins; coaches; Supervision. |
| **Approver**      | Order approver          | Approves sales orders.                                                               |
| **Sales**         | Salesperson (KAS, RDS…) | Writes their own MCP; runs the day on the phone; reads set-up data only.             |
| **Analyst**       | Head office reporting   | Reads everything, changes nothing.                                                   |
| **Viewer**        | Read-only user          | Reads their own unit, changes nothing.                                               |

Who may approve or decide:

| Decision                               | Allowed roles                             | Where                            |
| -------------------------------------- | ----------------------------------------- | -------------------------------- |
| Approve or return an MCP               | Super admin, Sales manager                | Field › Coverage › Review        |
| Approve or reject a new store          | Super admin, Sales manager                | Field › Coverage › Setup         |
| Verify or reject a GPS pin             | Super admin, Administrator, Sales manager | Outlets › Verification           |
| Approve or reject a location exception | Super admin, Sales manager                | Field › Supervision › Exceptions |
| Approve or reject a sales order        | Super admin, Sales manager, Approver      | Approvals (`/workflows`)         |
| Suspend, reinstate or revoke a phone   | Super admin, Administrator                | Admin › Phones                   |

Nobody can approve their own plan, their own new store, their own pin or their own visit.
Use a different person (and login) for each side of an approval.

## 2. Your month, week and day at a glance

Supervisor's month (Client rule):

1. Last week of the month: each salesperson submits next month's MCP.
2. Check **MCP deadlines** for people with **No submitted MCP**.
3. Review and approve each plan by the end of the first week of the new month.
4. If you will be away, record an away period so your manager can approve for you.

Supervisor's day:

1. Open Field › Supervision › **Team** to see who has started, who is in a call and who
   is behind.
2. Open **Exceptions** and decide the items under **Needs decision**.
3. After 10:00 PM, check **Not visited** rows and DAR / ROAR submissions.

Supervisor's week:

1. Record your Work-With sessions and check **Behind** in **Work-With**.
2. Follow up open Talk Sheet items.

Administrator's routine:

1. Invite new people, then assign their unit, role, position and supervisor.
2. Keep territories, routes and outlet assignments current, with future effective dates.
3. Suspend or revoke phones when they are lost, replaced or the person leaves.

## 3. Master Coverage Plan (MCP): writing a plan

The MCP is a salesperson's plan for the month: which stores they visit, on which days,
in which order, plus non-visit activities such as Work-With. Money follows the approved
plan: per diem is checked against it (Client rule).

Who can write a plan: the salesperson for themselves, or a Sales manager, Administrator or
Super admin for someone in their units.

Deadline (Client rule): submit in the last 7 days of the month before; approval is due by
the end of day 7 of the plan month. Late plans are flagged, not refused.

### 3.1 Start a plan

1. Open Field › Coverage (`/sales-force`).
2. Click the **Plan** tab.
3. Choose the person in **Assignee**. A salesperson can only choose themselves.
4. Choose the **Month**.
5. Click **New plan**. The new version starts as **draft**.

To continue an existing plan, click its version button (v1, v2, …) instead. Its status is
shown next to it. You cannot create a plan for a past month. A new plan for the current
month starts today.

Only change **Assignment period** if the person starts or stops mid-month:

1. Set **From**.
2. Set **To**. This is the first day after the assignment ends.
3. Enter a **Reason**.
4. Click **Save assignment**. A backdated assignment is refused.

### 3.2 Choose the stores

1. Select a **Territory**.
2. Optionally select a **Route** (or **All routes**).
3. Pick a store in **Select assigned outlet**. Only stores assigned to that territory are
   offered, and stores already in the plan are left out.
4. Click **Add outlet to plan**. Repeat for every store.
5. For each store set **Frequency** (weekly, biweekly, monthly or custom), **Preferred days**
   (including Sat) and **Duration** in minutes.
6. Optionally enter **Outlet objectives**, separated by commas.
7. For a custom frequency, enter the **Custom dates** as YYYY-MM-DD, separated by commas,
   inside the plan month.
8. Click **Remove** next to a store you do not want. This only removes it from the plan.
9. Click **Save outlet cadence**.

The cadence is a default only. It does not fill in the visit dates for you.

### 3.3 Fill in the visit days

1. In the **Outlet / day** grid, click **+** where a store's row meets a date. The cell
   shows a tick.
2. Set the **Daily sequence**: the stop number for that day (1, 2, 3 …). Each store on a
   day needs a different number.
3. Optionally enter **Visit objectives, comma-separated** for that one visit.
4. Click the tick again to remove a visit.
5. **Add row** puts a store on every open date of the month; clicking a date heading puts
   every store on that date. Use these only when that is really what you want.

Past dates and dates outside the plan cannot get a new visit.

Plan the stop order carefully. Client rule: the salesperson must close the current call
before starting the next store, and a later stop cannot start until the earlier planned
stops of that day are closed.

### 3.4 Add non-visit activities (Work-With, meetings)

1. Optionally click **Apply weekly routine** first to copy the position's weekly routine.
   It adds activities, not store visits.
2. Under **Non-visit activities (including DS Work-With)** set the **Date**.
3. Enter the **Activity name**.
4. For a Work-With, enter the **Named truck (DS Work-With)**. A Work-With without a truck is
   refused.
5. Click **Add activity**.
6. Click **Save dated slots**.

Save the assignment period and cadence before editing the grid: saving them reloads the
editor, and unsaved grid changes are lost.

### 3.5 Import the plan from Excel or CSV instead

Sales admins and supervisors can load a plan from a sheet. The plan must already exist as
a draft.

1. Open Commercial › Imports (`/imports`).
2. Click **Route sheets**.
3. Choose the **Month**.
4. Choose the **Draft plan**. Click **More plans** if it is not listed.
5. Choose the **Sheet type**: **Dated visits** (with service dates) or **Route defaults**
   (store defaults only).
6. Click **Template** and fill it in. Do not change the column names or order.
7. Save as .csv or .xlsx (only the first worksheet is read).
8. Click **Upload file**, then **Preview file**.
9. Check **Rejected rows**. Click **Download errors** for a list to fix.
10. Click **Merge rows** to add the accepted rows to the draft. This does not submit it.
11. Check the result under **History**.
12. Go back to Field › Coverage and check the visits in **Calendar** before you submit.

Sheet rules: keep all codes as text in Excel (so leading zeros stay); dates as YYYY-MM-DD;
at most 500 rows; the employee code must match the plan's person; objectives are separated
by semicolons; Route defaults cannot use the custom frequency.

### 3.6 Submit

1. Open Field › Coverage › **Plan** and select the version.
2. Read **Advisory warnings**, if any.
3. Click **Save outlet cadence** and **Save dated slots** if you changed anything.
4. Click **Submit for approval**. You see **Submitted for independent approval.**
5. The version now shows **submitted** and cannot be edited until it is returned.

Submit only sends what is saved. A plan with no dated visits cannot be approved.

## 4. Reviewing, returning and approving a plan

For Sales managers and Super admins.

### 4.1 Review

1. Open Field › Coverage › **Review**.
2. Choose the **Month** and the **Plan** (person, version and status).
3. Read the **Exceptions** card above the review. Anything **blocking** must be fixed
   before you can approve (see section 8).
4. Check **Prepared by** and who submitted it.
5. Read **MCP approval**: the **Approve by** date, the direct supervisor and whether you
   may approve (and why not, if you may not).
6. Check **Dated slots**: date, store, route, stop number, objectives and Work-With truck.

You cannot approve or return a plan that you wrote, submitted or that is your own.

### 4.2 Return for changes

1. Type the **Return reason**. It cannot be blank.
2. Click **Return plan**. You see **Returned to draft with reason.**
3. The planner sees the version back in **draft**, marked **Returned for changes** with your
   reason. They fix it and click **Submit for approval** again.

### 4.3 Approve

1. Click **Approve**.
2. You see **Plan approved and signed.**
3. The status becomes **Approved · future** (month not started) or
   **Approved · awaiting activation**.

Approval freezes ("signs") the exact plan: stores, codes and names, routes, stop numbers and
dates as they were at approval, with the approver and time. Later changes to store or route
data do not change a signed plan. An approved plan cannot be edited; it can only be revised
(section 6).

Approval can still be refused for a visit date already past, two stores with the same stop
number on a day, or a store no longer assigned to the route.

## 5. Backup approver when the supervisor is away

Client rule: the supervisor approves; if the supervisor is away, their manager approves.

The system names the direct supervisor in **MCP approval**. While an away period is in
effect, the supervisor's own manager can approve as backup.

To record an away period:

1. Open Field › Coverage › **MCP deadlines**.
2. Under **My away periods** set **Away from** and **Away until** (the last day away is
   included).
3. Enter a **Reason**.
4. Click **Record away period**. Backdated or overlapping periods are refused.
5. To come back early, click **End** on the period.

The supervisor, their manager or a people administrator of their unit can record it. If no
supervisor is recorded for the salesperson, the screen says
**No direct supervisor recorded; any MCP approver in scope may approve.**

## 6. Activating a plan and changing an approved plan

### 6.1 Activation

Each approved plan turns into the salesperson's planned visits automatically on its start
date. If needed you can do it by hand:

1. Open Field › Coverage › **Review** and select the approved plan.
2. Click **Generate visits** (available from the start date; before that it says
   **Activation starts on the effective date.**).
3. You see **Planned visits reconciled.** and the plan becomes **Active**. Clicking again
   never creates duplicates.
4. Check the **Visits** tab for the planned visits.

### 6.2 Revising an approved plan mid-month

1. Open Field › Coverage › **Plan** and select the approved or active version.
2. Set the **Revision date** (today or later).
3. Enter the **Revision reason**.
4. Click **Revise**. A new draft version is made with the remaining visits.
5. Change it, then **Submit for approval**. It needs a new, independent approval.
6. Check **History** (**Plan history**) for who changed what and when.

When the revision becomes active, the old plan's future visits that were not started are
marked **replaced** or **cancelled**. Visits already worked are kept.

## 7. Coverage views

Open Field › Coverage, choose the **Month** and, where asked, the **Plan**. Most views can
be narrowed by **Territory** and **Route**; **All** removes a filter. Use **Next page** and
**First page** to move through long lists.

| Tab               | What it shows                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------- |
| **Calendar**      | The plan by **Day**, **Week** or **Month**, with stop number, store, route and status.       |
| **Map**           | Store pins of the plan. Only **Verified** pins are drawn. Not live tracking of people.       |
| **Route**         | Per territory and route: which stores are **Covered** (in the plan) or **Uncovered**.        |
| **Workload**      | Per person: planned calls and minutes against the call target (**Over**, **Under**, **On**). |
| **Standards**     | The confirmed **Call standards** per position and the **Productive call** rule.              |
| **MCP deadlines** | Who has not submitted, who awaits approval and who is approved, with late flags.             |
| **Exceptions**    | Problems in the selected plan (section 8).                                                   |
| **Visits**        | The planned visits generated for the person and month.                                       |
| **History**       | Every change to the plan.                                                                    |
| **Export**        | CSV download and a printable plan.                                                           |

Notes:

- **Map** table badges: **Planned** or **Uncovered**, **Assigned** or **Unassigned**,
  **Verified** or **Unmapped**. An unmapped store still can be visited: there is no fixed
  check-in distance (Client rule); the phone records the location for review.
- **Workload** counts planned calls, not completed or productive calls. People with no plan
  for the month are not listed; check **MCP deadlines** for them.
- **MCP deadlines** statuses: **Not yet due**, **Due**, **Overdue** (no plan submitted);
  **Awaiting approval**, **Approval late**; **Approved**, **Approved late**.

### 7.1 Export and print

1. Open **Export** and select the plan.
2. Optionally filter **Territory**, **Route** and **Visit status**.
3. Click **Export CSV** to download the whole filtered plan.
4. Or click **Prepare print**, check the header (approver and **Signed:** code, or
   **Not approved**), then click **Print / Save PDF**.

After changing a filter, click **Prepare print** again.

## 8. Plan exceptions (before approval)

The **Exceptions** tab (also shown above **Review**) checks a draft or submitted plan.

- **blocking** items stop approval. Fix them first.
- **advisory** items are warnings. You may still approve.

Each row shows the problem, the date and a suggested fix. To fix:

1. If the plan is submitted, **Return plan** first (submitted plans cannot be edited).
2. Fix the plan, or the store/route data, as the suggested fix says.
3. Click **Recheck**.
4. Submit again.

Common suggested fixes:

| Suggested fix shown                                       | What to do                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| **Reactivate or remove the draft visit**                  | Store is inactive or missing: reactivate it or remove it from plan. |
| **Repair the local customer link or reactivate customer** | Fix the store's customer link (section 12).                         |
| **Correct overlapping or missing territory assignment**   | Assign the store to exactly one territory for that date.            |
| **Align draft route and outlet assignment**               | The store is on a different route than planned.                     |
| **Move slot into plan period**                            | A visit date is outside the plan month.                             |
| **Edit draft cadence dates**                              | A custom frequency has no valid dates.                              |
| **Request and verify an outlet pin**                      | Advisory: the store has no verified GPS pin.                        |
| **Review both verified pins**                             | Advisory: two stores share the same pin.                            |
| **Optionally assign an ordered route**                    | Advisory: the store is in a territory but on no route.              |

An approved or active plan is not re-checked against today's data; it stays as signed.

## 9. New-store approvals

Client rule: the salesperson pre-enrols a new store on the phone with a customer
information sheet (CIS) or a store photo. The store stays provisional until a supervisor or
manager approves it. The system issues the customer code; nobody types it. Existing stores
keep their current codes.

1. Open Field › Coverage › **Setup**, then **Outlets**.
2. Find **New stores to approve**.
3. Check the store name, channel, who proposed it, the address, contact and GPS position.
4. Open the store photo or the **Customer information sheet**.
5. To approve: click **Approve**, enter the **Approval reason**, click
   **Approve and issue code**. You see **Store approved. Customer code** followed by the new
   code. The store's GPS pin is verified at the same time.
6. To reject: click **Reject**, enter the **Rejection reason**, click **Reject store**. You
   see **Store rejected and deactivated.**
7. **Cancel** closes the form without a decision.

If you proposed the store, the buttons are disabled:
**Another approver must decide your own proposal.** Recent decisions are listed under
**Recent new-store updates**.

## 10. Organization units, people and teams

For Administrators and Super admins: open **Admin** (`/admin`).

Changes to units, teams, territories, routes and assignments are effective-dated: you pick
a future **Effective date**, and the change starts at midnight (Manila) that day. History is
kept. Name edits apply at once.

### 10.1 Invite a person

1. Open Admin › **Invitations**.
2. Under **Invite person** enter **Full name** and **Email**.
3. Choose the **Role** and, if known, the **Position** (or **No position**).
4. Click **Send invitation**. You see **Invitation sent**.

Only a Super admin can invite an **Administrator**. Inviting and revoking need a national
administrator or the Super admin.

A new person starts with no unit and cannot use unit screens until one is assigned
(next step).

To stop someone's access: find the invitation and click **Revoke access** (**Access revoked**).
This also disables their login. To stop only one phone, use section 13 instead.

### 10.2 Assign unit, role, position and supervisor

1. Open Admin › **People**.
2. Click **Assign** on the person's row.
3. Choose the **Unit**, **Role** and **Position**.
4. Find their **Supervisor** (use **Search supervisors** if needed).
5. Enter the **Employee code** if it is empty. It cannot be changed once set.
6. Enter a **Reason** and click **Save assignment**.
7. Click **History** on the row to see past assignments.

The supervisor must be above the person in the hierarchy. The supervisor you choose here is
the one who approves the person's MCP.

### 10.3 Organization units

1. Open Admin › **Organization**.
2. To add a unit: click **Create child** on the parent, enter **Code** and **Name**, choose
   the **Unit type**, set the **Effective date**, enter a **Reason**, click **Save change**.
3. To move a unit: click **Reparent**, choose the **New parent**, set the date and reason,
   click **Save change**.
4. To rename or close: click **Edit name** or **Deactivate**, then **Save change**.
5. Use **As of** to see the tree on another date. Clear it before editing.

A unit with active units under it cannot be deactivated.

### 10.4 Teams

1. Open Admin › **Teams** and click **New team**.
2. Enter **Code**, **Name**, choose the **Unit**, set the **Effective date** and **Reason**,
   click **Save change**.
3. Click **View team**, then **Add member**, choose the **Person**, set the date and reason,
   click **Save change**.
4. Use **Remove member** or **Deactivate team** the same way. **Membership history** shows
   past members.

## 11. Territories and routes

Territories are managed by Administrators. Routes, outlets and outlet assignments can also
be managed by Operations (sales admin). The same screens are under Admin and under
Field › Coverage › **Setup**.

### 11.1 Territories

1. Open Admin › **Territories** and click **Create territory**.
2. Enter **Code**, **Name**, optionally **Channel**.
3. Choose the **Owning unit**.
4. Set the **Effective date** (and an **End date** only if it has a planned end).
5. Enter the **Reason (required)** and click **Save**.

On an opened territory (**Open**):

- **transfer** moves it to another owning unit from a date. See **Ownership history**.
- **assign** gives it a primary **Salesperson** from a date. **End assignment** ends one.
- **edit** changes the name, channel or boundary at once; **deactivate** closes it from a
  date.

The **No salesperson assigned** filter finds uncovered territories. The optional boundary
is advisory only; it does not block check-in.

### 11.2 Routes

1. Open Admin › **Routes**, choose the **Territory**, click **Create route**.
2. Enter **Code** and **Name**.
3. Optionally tick the days in **Weekday template (Monday=1)** and the cycle length.
4. Set the **Effective date** and **Reason (required)**, click **Save**.

On an opened route:

- **move** puts it in a **Destination territory** from a date. If you see
  **Move requires outlet reassignment first**, reassign its stores first (section 12.3).
- **assign** gives it a **Salesperson** (tick **Primary owner** for the main one).
- **edit**, **duplicate** and **deactivate** are also available.

If you see **Revise the approved coverage plan first**, an approved MCP uses this route or
store. Revise that plan (section 6.2) before the change.

## 12. Outlets, GPS pins and route order

### 12.1 Create or edit an outlet

1. Open Admin › **Outlets** and click **Create outlet**.
2. Enter **Code**, choose the **Custodian unit**, enter **Name**.
3. Choose the **Site status**: **Prospect / unlinked** or **Active**.
4. Fill in address, channel, contact and visit details you know.
5. Enter a **Reason** and save.

To edit: **Open** the outlet, click **Edit profile**, change and save. To link it to a
customer account: **Change customer link**, choose the **Existing customer** (or
**Unlink (prospect)**), set the date and reason, save. **Customer history** keeps the
changes.

New stores found in the field should come through the phone and new-store approval
(section 9), not through **Create outlet**.

### 12.2 GPS pins

Two different people are needed: one proposes, another verifies.

To propose:

1. Open the outlet. Under **Verification** click **Propose GPS pin**.
2. Enter **Latitude** and **Longitude**.
3. Optionally change **Radius meters (default 75)**. Use a larger radius for a mall or
   warehouse.
4. Enter the **Source** and, if useful, an **Evidence note**.
5. Optionally set **Future effective date (optional)**.
6. Enter a **Reason** and save.

To verify (Sales manager, Administrator, Super admin — not the proposer):

1. Open the outlet and look under **Verification** for the **Pending** pin.
2. Click **Approve** or **Reject**, enter a **Reason** and save.
3. The pin shows **Verified** or **Rejected**.

The pin radius never blocks a check-in (Client rule: no fixed distance). A check-in
outside the radius is only flagged for the supervisor (section 15). Only verified pins show
on the coverage map.

### 12.3 Assign outlets to a territory and route, and set stop order

1. Open Admin › **Assignments**.
2. Choose the **Territory** and the **Route** (or **No route (territory only)**).
3. Select the stores: tick them, or click **History** next to one.
4. Enter the **Starting sequence** (stop numbers count up from it in the order you
   selected).
5. Set the **Effective date** and **Reason**.
6. Click **Assign selected** (unassigned stores) or **Reassign selected** (moving stores).
7. To change stop order, use **Up** and **Down** under **Route stops**, set the date and
   reason, click **Save stop order**.

**Preview date** only changes the date you are looking at; it does not set when a change
starts. Future assignments appear from their start date.

## 13. Phones: suspend, reinstate, revoke, lost phone

For Administrators and Super admins of the person's unit. Salespeople use their own phones
(Client rule). One person can have only one active phone.

1. Open Admin › **Phones**.
2. Filter by **Status**: **All phones**, **Active**, **Suspended**, **Revoked**.
3. Click **View phone** to see **Last contact**, **Last upload received**,
   **Offline access until**, **Received from this phone** and **History**.

| Action              | When                                   | Reasons you can pick                                                                                                          |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Suspend phone**   | Lost, may turn up; reversible          | **Lost**, **Stolen**, **Suspected compromise**, **Other**                                                                     |
| **Reinstate phone** | A suspended phone was found            | **Found**, **Other**                                                                                                          |
| **Revoke phone**    | Permanent: replaced, left, transferred | **Lost**, **Stolen**, **Suspected compromise**, **Replaced by a new phone**, **Employee transferred**, **Retired**, **Other** |

Steps: click the action, choose the **Reason**, click the action button again to confirm.
**Cancel** stops.

Lost phone:

1. Find the phone and click **View phone**.
2. **Suspend phone** with reason **Lost**.
3. Check **Last upload received** and **Received from this phone**: that work is safe on the
   server.
4. Work still on the phone and not sent cannot be recovered from the web. A suspended or
   revoked phone keeps its unsent work; it is not deleted. Missed visits go through the
   supervisor's normal process.
5. If the phone is found, **Reinstate phone**. If not, or the person gets a new phone,
   **Revoke phone** (permanent) before the new phone is enrolled.

A revoked phone can never be reinstated. A person who moved unit needs the old phone
revoked and a new enrolment.

## 14. Watching the field day (Supervision)

Open Field › Supervision (`/supervision`). For Sales managers, Administrators, Super
admins, Analysts and Viewers. Choose the **Date**, and if shown the **Unit** and
**Channel**. Tick **My team only** to see only your direct reports.

### 14.1 Team

People are grouped by channel. The cards show **Calls**, **Productive**, **Not started** and
**To review**. Each person's row shows **Calls** (done against planned), **Productive**,
**First in**, **Last out**, **Last sync**, **Flags** and **Status**.

Client rule: a call is a store in the day's plan that was visited, order or not. It is
productive when any one of the listed activities was recorded (order, merchandising,
inventory retrieval, suggested order, negotiation, bad-order pickup, collection, meeting).
See Field › Coverage › **Standards** for the exact list and targets.

| Status          | Meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| **In call**     | A call is open now.                                                    |
| **No plan**     | No planned stops and no calls today.                                   |
| **Done**        | All planned stops are done.                                            |
| **Not yet**     | No check-in yet, before the expected start time.                       |
| **Not started** | No check-in by the expected start time.                                |
| **On route**    | Has started and is working.                                            |
| **Idle**        | No update for a while during the day (shown with hours, e.g. Idle 2h). |
| **Incomplete**  | The day closed with planned stops not done.                            |
| **No calls**    | The day closed without any check-in.                                   |

**Flags** shows counts of **to review** (location to decide), **out of order**, **late sync**
(sent after the 10:00 PM close, or long after capture) and **unplanned**.

The expected start (9:00 AM) and idle time (90 minutes) are provisional settings, not
confirmed Sunpride rules.

### 14.2 Map

1. Click **Map**.
2. Choose **Everyone** or one person, and a **Territory**.
3. Click a marker to see the person, store, status and check-in time.
4. Read the stop list under the map.

Stop labels: **Not visited**, **In call**, **Productive**, **Nonproductive**, **Visited**,
plus **Unplanned** and **No pin**. Lines join visited stores in check-in order; they are not
live GPS tracking. If the map fails, **Map unavailable. List below.** — use the list.

If a notice like "First … shown. Pick a unit." appears, narrow the filters: you are not
seeing everyone.

## 15. Field exceptions: deciding location evidence

Open Field › Supervision › **Exceptions**.

- **Needs decision**: location evidence you can approve or reject.
- **Other exceptions**: items to follow up with the person; there is nothing to decide.

| Exception         | Meaning                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| **Location**      | Check-in or check-out location needs review: **Outside radius**, **No location** or **Weak fix**. |
| **Out of order**  | A stop was checked into after a later stop (against the MCP order).                               |
| **Unplanned**     | A visit to a store not in the day's plan.                                                         |
| **Nonproductive** | A visit with no productive activity, with the reason given.                                       |
| **Rescheduled**   | A planned stop was replaced by a plan revision.                                                   |
| **Cancelled**     | A planned stop was cancelled.                                                                     |
| **Not visited**   | A planned stop with no visit. Shown only after the 10:00 PM close.                                |

To decide a location exception (Sales manager or Super admin only):

1. Read the person, store, the location result, the distance and the GPS accuracy.
2. Open **History** on the row if shown.
3. Choose a **Reason**:
   - to approve: **Pin outdated**, **Large site**, **Weak signal**, **Store moved**,
     **Confirmed by call**;
   - to reject: **Not at store**, **No valid reason**, **Suspected fake location**.
4. Click **Approve** or **Reject** (only the matching button is enabled).
5. The row shows **Approved** or **Rejected**, who decided and when.

Rules: you cannot decide your own visit; each item can be decided once; the decision is
recorded separately and never changes the original location. If the pin itself is wrong
(**Pin outdated**, **Store moved**), also propose a new pin (section 12.2).

## 16. Coaching: Work-With, Talk Sheet, trainer forms

### 16.1 Work-With

Client rule: counted per position, using the memo's weekly minimums: Sr CDS 1, CDS 3, DS 4
a week.

1. Open Field › Supervision › **Work-With**.
2. Read **Trainers**, **Behind** and **Done this month**, and **Work-With cadence**.
3. Under **Sessions this month**, click **Open** to read a session.

To record your own session (**My Work-With**):

1. Choose who you are working **With** and the **Date**.
2. Choose the **Objective**: **Training** or **Sales and validation**.
3. Choose **Work with**: **Booking** or **Truck** (enter the **Truck**).
4. Click **Start**.
5. Add observations with **Add BCP** and **Add PSF**, and fill in the objective's fields.
6. Click **Save** to keep a draft. Clear everything under **Still needed to complete**.
7. Click **Save and complete**.

Only completed sessions count.

### 16.2 Trainer forms

Inside a Work-With session, under **Trainer forms**:

1. Click **Add training program**, **Add training sheet** or **Add job evaluation**.
2. Fill it in, click **Save** for a draft, then **Save and sign**.
3. The form shows **Waiting for trainee** until the trainee clicks **Acknowledge** in
   Field › **Training**. Then it shows **Acknowledged**.

### 16.3 Talk Sheet

1. Open Field › Supervision › **Talk Sheet**.
2. Read **Partners**, **Open items**, **Overdue** and **Root-cause review**.
3. Under **My Talk Sheets** choose the **Partner** and **Meeting date**, click
   **Start Talk Sheet**.
4. Click **Add gap or issue** for each item: the gap, agreement, corrective action, who is
   responsible and by when.
5. Enter **Acknowledged and committed by** and the **Next contact** date.
6. Click **Save** for a draft, clear **Still needed to sign off**, then
   **Save and sign off**.

Open items carry over to the next Talk Sheet. An item open for a month needs a root-cause
review.

## 17. Reports a supervisor reads

- Field › **Daily sales report**: choose the **Date** and **Salesman**. Shows
  **Today's sale**, **MTD performance**, **MTD balance to sell**, **Productive calls**,
  **Actual coverage**, **Categories** and **Programs**. Made from recorded orders and
  visits; nobody types it. **Export CSV** or **Print / Save PDF**.
- Field › **Call sheets**: find the account (or enter the **Outlet code**), click **Open**,
  then **Month sheet** and the **Month**. **Export CSV** or **Print / Save PDF**.
- Field › **DAR / ROAR**: click **Team submissions**, choose **Week ending**, **Unit** and
  **Report**. **Filed**, **Late** and **Missing this week** summarise the week; click a
  person's day to see their calls and what they filed. Reports are due daily by 10:00 PM
  (Client rule). Statuses: **Submitted**, **Late**, **Due 10 PM**, **Missing**,
  **Off day**. Supervisors read these; there is no approve step.
- Reports (`/analytics`) › **Customer execution**: choose **As of** and **Period**, type in
  **Find a store**, then click the store. Shows **Visit regularity**, **Days since last
  order**, **Order trend (last 4 weeks)**, **Missed planned calls**, **Distribution** and
  **On-shelf availability**, then **Week by week** and **Assortment and distribution**.

## 18. Order approvals

Open **Approvals** (`/workflows`). For Sales managers, Approvers and Super admins.

1. Read **Order**, **Customer**, **Status** and **Total**. Waiting orders show **Waiting**.
2. Click **Approve** or **Reject**. The decision is made at once (no confirm step).
3. When the list is empty you see **Nothing waiting**.

You never see your own orders here. Approval sends the order on to SAP; check SAP
integration for the result.

Outside calls (a store sends a PO but is not in today's plan): the sales admin encodes the
PO under Commercial › **Outside-call POs**, and the salesperson records the activity
(Client rule).

## 19. Troubleshooting

| You see / problem                                     | Do this                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| A new person sees nothing after signing in            | Assign their unit in Admin › **People** (section 10.2).                      |
| **Review** tab is missing                             | Only Sales managers and Super admins approve plans.                          |
| Approve is disabled on a plan                         | You prepared or submitted it, it is your own, or it has blocking exceptions. |
| **Revise the approved coverage plan first**           | Revise the MCP that uses that store/route, then make the change.             |
| **Move requires outlet reassignment first**           | Reassign the route's stores first, then move the route.                      |
| A store is missing from the coverage map              | It has no verified pin. Propose and verify one (section 12.2).               |
| Imported visits do not show as ticks in the plan grid | Check them in **Calendar** or **Dated slots**; see section 20.               |
| A phone cannot sync after being found                 | It may be revoked (permanent). Enrol it again as a new phone.                |
| A list says only the first part is shown              | Narrow the **Unit** or other filters.                                        |

## 20. Not in the system yet / open client questions

Not built yet in the web app (as of this guide):

- Phone enrolment is done by an administrator call, not from Admin › **Phones**; the
  **Phones** screen only reviews, suspends, reinstates and revokes. Enrol pilot phones with
  the development team.
- Person assignments in Admin › **People** take effect immediately; there is no future date
  there.
- A national Administrator does not see newly invited people with no unit in
  **People**; ask the Super admin to assign their first unit.
- Phone remote wipe is not available.
- Plans imported from a sheet may not show as ticks in the **Outlet / day** grid; check them
  in **Calendar** before editing.
- No reminder emails or texts for late MCPs; use **MCP deadlines**.
- No per diem screen yet; per diem is checked against the approved plan.
- New-store submission is done on the phone only, not on the web.

Waiting for Sunpride (from the 2 October call):

- Customer code format for new stores.
- KAS and Booking productive-call target: 85% (email) or 90% (memo).
- Whether a visit outside the approved plan can ever be paid, and the proof needed.
- Whether the monthly Work-With minimum is always 4 times the weekly number.
- Expected start time and idle time for the Supervision status (we use 9:00 AM and 90
  minutes for now).
- Original Daily Sales Report and Call Sheet Excel templates.
