# Monthly coverage plans and daily routes

SP-0224 implements the 20 November client correction. The owner question is: does each salesman have approved, dated customer stops for the coming days, and which customers are under-planned?

## Salesman

1. Open Coverage plans > My plan on the website. The same website works in a phone browser; a new native monthly-plan editor is not required for this flow.
2. Choose the month and Add plan. Choose one of your territories, add its customers, and select visit dates in the grid. Set each day's stop order in the Sequence fields. Location and Customer group territories use the same assigned customer roster.
3. Read the customer-frequency warnings. They use the office's customer requirement, not the draft cadence selector. An omitted assigned customer also appears as zero planned visits. Warnings are advisory, not a reason to silently reject the plan.
4. Submit for approval. The visible customer roster and grid are saved together with submission; a failed write does not partly submit the plan.
5. If returned, read the manager's reason, adjust the plan, and submit again.

## Manager / CDM

Open Coverage plans > Review, select the salesman and submitted month/version, and approve or return it with a reason. The existing assigned-supervisor and authorized-absence backup rules apply. A salesman, preparer or submitter cannot approve their own plan.

Approval creates one dated route identity for every day with customer visits. Route 001 is an example, not a recurring weekday template. Each route contains that day's signed stops in sequence. Open the plan to expand the dated routes. The existing automatic activation job creates the Field app's planned visits when the plan becomes effective; no extra office activation action is needed. The phone receives its current and upcoming daily stops on Sync, with today's dated route in the header and each stop's dated route in its agenda.

## Weekly review

The coming week is Monday–Sunday. Review is due before the end of Saturday in Manila time. The My plan panel shows the due date, highlights a reminder from Thursday, and marks an unfinished review overdue on Sunday. These are in-app website reminders, not an email or operating-system push notification.

Use Keep these routes when no changes are needed. The confirmation is tied to that approved version and its content. Use Adjust coming week to copy the future suffix into a revision. Change its visits and submit for independent approval again. Full-month custom cadence dates remain available as defaults, including earlier days retained by the original plan; only the revision's actual dated slots create replacement work. Pending changes cannot be confirmed as reviewed. Old approved routes stay in place until the approved replacement takes effect; earlier visits and route history remain readable. A week crossing months shows both months and names dates without an approved plan. Reviewed weeks stop displaying an overdue reminder.

## Frequency interpretation

Exact N times a month is used directly. Monthly means one visit. Day cadences use the number of calendar days divided by the interval, rounded up (for example weekly in a 31-day month shows five); this is a planning advisory, not an assertion about a prescribed weekday. Distinct customer/day occurrences are counted, not multiple activity rows. Revisions count the retained earlier portions of the approved month as well as the current suffix.

## Compatibility and operation

Migration 0837_mcp_daily_routes.sql is additive. It leaves old route masters, assignments, approvals and visits unchanged. New dated route IDs are stored separately in coverage_daily_routes and included in the signed approval snapshots; legacy route IDs remain available for old history and assignment checks. Legacy route-only personnel can continue planning while territory assignments are adopted. A territory assignment now permits planning its customers even when they retain old office route references.

The existing Field bundle's route and agenda fields carry the new labels; no Android source, handset installation or phone data reset is needed. The customer-level route assignment ID stays unchanged for cached customer and order associations. Today's header is empty when only future dated stops exist; it never falls back to a future stop's old weekday route. Old plans without dated-route snapshots retain their previous labels. Approval, replacement, authorization, current ownership checks, immutable executed work, and sync resnapshot fences remain in force.

Verification uses disposable SP224-owned local data, real cookie commands, native sign-in/device proof and signed Field downloads. This is not a production or physical-handset acceptance claim.
