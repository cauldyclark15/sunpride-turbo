# SFA platform blueprint

> **Status: reference design, not a decision record.** Written 2026-09-09 as the target architecture
> for the Sales Force Automation platform. Where it conflicts with an accepted ADR in
> `docs/decisions/`, the ADR wins — notably ADR-004 (PWA cancelled, van POS on Android handhelds) and
> ADR-010 (four products: web, native iOS field, native Android field, separate Android van POS).
> Its phase list is superseded by the milestones in the GitHub issue tracker. It is written in the
> first person as an advisory review; "I would" means "the recommended design".

---

You have the right foundation, but I would change one architectural assumption immediately: **do not treat the mobile apps as simple alternate frontends to the web app.** For this project, field mobility, offline operation, geolocation, device state, printing, truck inventory, and eventual synchronization are first-class domains.

I inspected your current `cauldyclark15/sunpride-turbo` repository. You already have a solid monorepo base with `apps/web`, `apps/pwa`, `apps/sap-connector`, `packages/backend`, shared UI/config packages, and substantial Convex inventory/order infrastructure. Your backend already contains separate domains for inventory, orders, profiles, master data, sales force, SAP integration, POS, manufacturing, reservations, transfers, counts, and posting, so I would **extend this architecture rather than rebuild it.**

The direction I recommend is:

> **Sunpride Turbo becomes Sunpride's internal Distribution Execution Platform.**
>
> BeatRoute is the reference model for SFA/MCP concepts, but Sunpride Turbo owns the workflows, data model, UX, analytics, route logic, inventory integration, van selling, and eventually AI-assisted execution.

BeatRoute itself positions its SFA around field-force execution, outlet/customer coverage, route planning, task execution, order taking, merchandising and sales productivity. That is the right conceptual benchmark, but Sunpride's system should go deeper on its own operational integration, especially inventory, SAP, truck stock and direct van selling.

---

# 1. Target system architecture

I would restructure the application layer to this:

```text
sunpride-turbo/
│
├── apps/
│   ├── web/                    # Next.js management/admin application
│   │
│   ├── field-ios/              # Native Swift / SwiftUI
│   │
│   ├── field-android/          # Native Kotlin / Jetpack Compose
│   │
│   ├── van-sales-android/      # Native Kotlin / Compose
│   │
│   └── sap-connector/          # Existing Bun SAP bridge
│
├── packages/
│   ├── backend/                # Convex
│   │
│   ├── domain-contracts/       # NEW
│   ├── integration-contracts/  # Existing SAP contracts
│   ├── design-tokens/          # NEW: platform-neutral design tokens
│   ├── ui/                     # Existing React/HeroUI only
│   ├── eslint-config/
│   └── typescript-config/
│
├── docs/
│   ├── architecture/
│   ├── product/
│   ├── mobile/
│   ├── workflows/
│   ├── decisions/
│   └── runbooks/
│
└── turbo.json
```

I would **retire `apps/pwa` as a production field application**.

Keep it temporarily as:

```text
apps/pwa-legacy/
```

or remove it once feature parity is achieved.

Your current README still defines the PWA as the offline-first field-sales/order-capture application. That architectural responsibility should move to the two native field apps.

---

# 2. The four operational surfaces

There are really four products here.

## A. Sunpride Management Web

Users:

- Sales directors
- National/regional sales managers
- Area managers
- Supervisors
- Sales admin
- Distribution managers
- Finance
- Inventory
- Operations
- Management
- System administrators

Primary responsibility:

**Plan → assign → monitor → analyze → approve.**

This is where your Master Coverage Plan lives.

---

## B. Field Sales iOS

Native SwiftUI.

Users:

- Sales representatives
- Account executives
- Sales supervisors
- Merchandisers if applicable
- Territory representatives

Responsibility:

**Execute the coverage plan.**

It should not look like an ERP.

It should look like a workday assistant.

---

# C. Field Sales Android

Native Kotlin + Jetpack Compose.

Feature-equivalent to iOS.

The business workflows should be identical, although platform UX conventions can differ.

---

# D. Van Sales / Truck POS Android

This is **not simply the Android field-sales app with POS enabled**.

Treat it as its own application because its consistency model is different.

Users:

- Van salesman
- Cashier
- Truck crew
- Driver/assistant where required

Responsibility:

```text
Load inventory
→ travel route
→ sell
→ receive payment
→ print invoice/receipt
→ decrement truck inventory
→ reconcile cash
→ reconcile remaining stock
→ close trip
```

This must work with effectively **zero connectivity**.

---

# 3. Your core business abstraction should be MCP

Because the first Sunpride meeting was almost entirely about BeatRoute's Master Coverage Plan, I would make MCP the organizing domain of the first release.

Do not model MCP as:

```text
salesperson -> customer list
```

That will become inadequate very quickly.

Model it as:

```text
Organization
   ↓
Sales Channel
   ↓
Region
   ↓
Area
   ↓
Territory
   ↓
Route / Beat
   ↓
Coverage Plan
   ↓
Cycle
   ↓
Day
   ↓
Outlet Assignment
   ↓
Planned Visit
```

For example:

```text
Modern Trade
    Cebu Region
        Cebu North
            Territory CEB-N01
                Route Monday-A
                    Gaisano Store 001
                    Customer 002
                    Customer 003
```

Another hierarchy may be:

```text
General Trade
  Visayas
    Cebu
      Mandaue
        Route 14
```

Do **not hard-code Sunpride's hierarchy names**.

Make hierarchy levels configurable.

---

# 4. Master Coverage Plan model

The MCP needs to answer five questions:

```text
WHO
visits

WHICH CUSTOMER
on

WHAT DAY
with

WHAT OBJECTIVE
and at

WHAT EXPECTED FREQUENCY
```

I would model:

```text
CoveragePlan

id
name

organizationUnitId
territoryId

cycleType
  weekly
  biweekly
  monthly
  custom

effectiveFrom
effectiveUntil

status
  draft
  submitted
  approved
  active
  superseded

version
```

Then:

```text
CoveragePlanAssignment

coveragePlanId
employeeId
role
effectiveFrom
effectiveUntil
```

Then:

```text
CoveragePlanOutlet

coveragePlanId
customerId

visitFrequency

preferredDay

sequence

visitType

expectedDuration

priority

salesObjective

merchandisingObjective

requiresOrder

requiresSurvey

requiresPhoto
```

This makes the MCP reusable instead of making route schedules permanent static records.

---

# 5. The customer is more than a customer master

For SFA, a customer must become an **Outlet** operational entity.

You will probably synchronize basic customer master data from SAP.

But operational data belongs to Sunpride Turbo.

Separate these concepts:

```text
SAP Customer
```

from:

```text
Sunpride Outlet Profile
```

Example:

```text
customers
---------
externalSapId
name
billingAddress
creditLimit
paymentTerms
priceList
taxClassification

outlets
-------
customerId

latitude
longitude
geofenceRadius

channel
subchannel
storeType

territoryId
routeId

contactPersons

salesPotential

visitFrequency

preferredVisitWindow

status

photo

verifiedLocation
```

This distinction will become extremely valuable later.

SAP does not need to know that:

```text
Store ABC
usually sells 10 cases/week,
needs freezer inspection,
is 37 meters from the registered GPS location,
was last visited Wednesday,
and normally orders Tender Juicy every Monday.
```

Turbo should know that.

---

# 6. Field Sales app information architecture

I would make the primary navigation extremely simple.

```text
Today
Route
Customers
Activity
More
```

Not:

```text
Inventory
Orders
Master Data
Sales Force
Transactions
Reports
```

That works for office software.

It is bad field UX.

---

# 7. Field app: Today screen

This is the most important screen.

Example:

```text
Good morning, Juan

Tuesday, September 9

TARGET
₱125,000

CURRENT
₱73,400

58.7%

8 / 14 visits completed
```

Then:

```text
UP NEXT

Gaisano Mabolo
850m away

Target: ₱12,000
Last order: ₱9,420
Last visit: 7 days ago

[ NAVIGATE ]
[ CHECK IN ]
```

Then:

```text
TODAY'S ROUTE

✓ Metro Colon
✓ Rose Pharmacy
✓ Prince Warehouse
● Gaisano Mabolo
○ Cebu Mart
○ Customer XYZ
```

The agent should immediately understand:

> Where do I go next?

---

# 8. Customer / outlet screen

When an agent opens an outlet:

```text
Gaisano Mabolo

General Trade
Route: Cebu North 04

Last visit
Sep 2

Last order
₱18,430

Outstanding
₱24,000

Suggested order
₱21,500
```

Tabs:

```text
Overview
Orders
Visit History
Products
Tasks
```

Actions:

```text
CHECK IN

CREATE ORDER

RECORD VISIT

COLLECT PAYMENT

REPORT ISSUE
```

---

# 9. Visit lifecycle

This should be an explicit state machine.

```text
PLANNED
   ↓
ARRIVED
   ↓
CHECKED_IN
   ↓
ACTIVITY_IN_PROGRESS
   ↓
CHECKED_OUT
   ↓
COMPLETED
```

Alternatives:

```text
PLANNED
 ↓
MISSED
```

or:

```text
PLANNED
 ↓
RESCHEDULED
```

or:

```text
PLANNED
 ↓
SKIPPED
```

Every skipped visit should require:

```text
reasonCode

store_closed
owner_unavailable
route_change
weather
vehicle_issue
customer_request
other
```

---

# 10. Check-in validation

When the salesperson presses:

```text
CHECK IN
```

capture:

```text
visitId
employeeId

serverTimestamp
deviceTimestamp

latitude
longitude

accuracyMeters

customerLatitude
customerLongitude

distanceFromOutlet

withinGeofence

networkStatus

deviceId
```

Potential policy:

```text
<= 75m
Valid Check-in

75–200m
Warning

> 200m
Supervisor exception
```

But make the radius configurable per outlet/type/territory.

Some stores will have huge properties, warehouses or malls.

---

# 11. Never trust GPS blindly

Maintain a geolocation confidence record.

Example:

```text
locationEvidence

provider
  gps
  network
  fused

accuracy

latitude
longitude

capturedAt

deviceTimestamp

serverReceivedAt

isMockLocation

distanceFromExpected
```

For Android especially, record whether the operating system reports mock-location behavior where available.

But avoid turning the application into employee surveillance.

Track what is necessary to execute business visits.

---

# 12. Visit intent

Your observation is correct.

Visits should carry intent.

Example:

```text
VisitIntent

SELL
COLLECT
MERCHANDISE
AUDIT
DELIVER
RELATIONSHIP_VISIT
PROMOTION
COMPLAINT
FOLLOW_UP
```

And allow combinations:

```text
SELL + COLLECT + MERCHANDISE
```

because real field calls often accomplish several objectives.

---

# 13. Visit activities

A visit should contain structured activity records:

```text
visitActivities

orderTaking

collection

inventoryCheck

merchandising

competitorSurvey

productAvailability

pricingCheck

promotionCompliance

photoCapture

notes
```

Do not store the entire visit as one JSON blob.

You will want analytics later.

---

# 14. Orders

You already have orders in Convex, so reuse that domain rather than inventing another SFA-specific order table. Your repository already exposes substantial order handling under `packages/backend/convex/domains/orders.ts`.

Add:

```text
order.source

FIELD_SALES
VAN_SALES
WEB
SAP
OTHER
```

And:

```text
visitId
coveragePlanId
salespersonId
territoryId
routeId
deviceId
```

---

# 15. Suggested order

This is where the future AI layer becomes valuable.

Eventually:

```text
Suggested Order =
historical velocity
+ days since last purchase
+ expected demand
+ active promotion
+ seasonality
+ outlet segment
+ stock availability
```

Agent sees:

```text
Suggested order

Tender Juicy 1kg
4 cases

Sunpride Bacon
2 cases

Holiday Ham
1 case
```

But initially, use deterministic rules.

Do not start with an LLM.

---

# 16. Product availability / assortment

Each customer should have an assortment profile.

Example:

```text
Outlet A

Required assortment:
✓ Tender Juicy
✓ Holiday Ham
✓ Bacon
✗ Cheesedog
```

Salesperson can record:

```text
available
low_stock
out_of_stock
not_carried
```

Now management can answer:

```text
Which Sunpride SKUs are missing from 7-Eleven stores in Cebu?
```

That becomes powerful distribution intelligence.

---

# 17. Merchandising

Potential tasks:

```text
display compliance
freezer placement
shelf share
price validation
promo material
product freshness
competitor presence
```

Evidence:

```text
photo
quantity
survey
note
```

Later you could add vision models for shelf/display verification.

---

# 18. Supervisor mobile capability

I would use the same Field Sales app with role-based capabilities.

Supervisor sees:

```text
MY TEAM

Juan
8 / 12 calls

Maria
10 / 11

Pedro
5 / 13
```

Map:

```text
assigned route
visit completion
exceptions
```

They should not see constant live dots unless Sunpride specifically requires that policy.

More valuable is:

```text
last business activity
visit progression
route adherence
exceptions
```

---

# 19. Web application modules

Your management web should evolve around:

```text
Dashboard

Sales Force
   Employees
   Teams
   Territories
   Routes

Coverage
   Master Coverage Plan
   Route Calendar
   Visit Plans
   Exceptions

Customers
   Customers
   Outlet Profiles
   Geolocation
   Segmentation

Execution
   Visits
   Activities
   Orders
   Collections
   Merchandising

Distribution
   Van Sales
   Truck Loads
   Truck Inventory
   Returns
   Reconciliation

Inventory

Sales Orders

Analytics

Integrations

Administration
```

---

# 20. Master Coverage Plan UI

This should become one of the strongest parts of the web application.

I would make it spreadsheet-like.

Example:

| Customer       |   M |   T |   W |   T |   F |   S | Rep   |
| -------------- | --: | --: | --: | --: | --: | --: | ----- |
| Gaisano Mabolo |   ✓ |     |     |   ✓ |     |     | Juan  |
| Prince Colon   |     |   ✓ |     |     |   ✓ |     | Maria |
| Rose Pharmacy  |   ✓ |     |   ✓ |     |   ✓ |     | Juan  |

Then alternative views:

```text
Calendar
Map
Territory
Employee
Customer
```

---

# 21. Coverage analytics

You need these metrics very early:

```text
Planned Calls

Actual Calls

Effective Calls

Productive Calls

Strike Rate

Coverage %

Order Conversion %

Average Order Value

Sales / Call

Sales / Working Day

Missed Calls

Unplanned Calls

Average Visit Duration
```

Terminology should be confirmed with Sunpride's sales leadership because FMCG organizations sometimes define these differently.

---

# 22. Proposed definitions

For example:

```text
Planned Call
A customer visit in the approved coverage plan.

Actual Call
A physical verified customer visit.

Productive Call
A visit resulting in qualifying business activity.

Effective Call
A visit fulfilling required visit objectives.
```

Make definitions configurable/report-documented.

---

# 23. Van sales architecture

This deserves a separate domain.

Think of the truck as:

> **a mobile warehouse plus mobile cash register.**

The truck receives inventory.

Example:

```text
Warehouse Cebu
   ↓ transfer
Truck V-014
   ↓ sale
Customer ABC
```

You already have inventory-transfer architecture in the backend, which is valuable here.

---

# 24. Truck inventory

Create:

```text
vehicles

vehicleCode
plateNumber
warehouseLocationId
assignedBranch
capacity
status
```

and:

```text
vanTrips

vehicleId
driverId
salespersonId
cashierId

routeId

startedAt
closedAt

status
```

Then:

```text
vanTripLoads

tripId
productId
batchId
quantity
```

---

# 25. Truck trip workflow

Morning:

```text
CREATE TRIP

↓
ASSIGN TEAM

↓
LOAD VEHICLE

↓
VERIFY LOAD

↓
DEPART
```

During route:

```text
ARRIVE CUSTOMER

↓
SELECT CUSTOMER

↓
CREATE SALE

↓
COLLECT PAYMENT

↓
PRINT RECEIPT

↓
DEDUCT TRUCK STOCK
```

Evening:

```text
RETURN TO DEPOT

↓
COUNT REMAINING INVENTORY

↓
COUNT RETURNS/DAMAGE

↓
RECONCILE SALES

↓
RECONCILE CASH

↓
CLOSE TRIP
```

---

# 26. Van inventory ledger

Do not calculate current van stock only from current quantity fields.

Use inventory movement records.

```text
LOAD          +100
SALE           -10
RETURN          -5
DAMAGE          -2
TRANSFER        -3
ADJUSTMENT      -1
```

Current:

```text
79
```

Your existing inventory ledger/posting architecture can support this concept and should remain the inventory authority instead of inventing separate stock logic inside the POS app.

---

# 27. Android POS architecture

Recommended:

```text
Kotlin
Jetpack Compose
Room
WorkManager
Coroutines
Flow
Hilt
```

Locally:

```text
Room DB
```

Remote:

```text
Convex
```

Printer:

```text
Bluetooth
USB
Embedded device SDK
```

Scanner:

```text
camera
hardware scanner
barcode intent
```

---

# 28. Bluetooth printer abstraction

Do not tie your application directly to one printer vendor.

Define:

```kotlin
interface ReceiptPrinter {
    suspend fun connect(): PrinterResult
    suspend fun print(receipt: Receipt)
    suspend fun cut()
    suspend fun openCashDrawer()
}
```

Then adapters:

```text
EscPosBluetoothPrinter
SunmiPrinter
ZebraPrinter
GenericUsbPrinter
```

This will save you considerable pain during hardware procurement.

---

# 29. Offline-first is mandatory

This is probably the single most important technical requirement.

Agents may operate in:

```text
rural Cebu
Visayas islands
warehouses
basements
large stores
roads
remote provinces
```

Connectivity cannot be assumed.

The mobile UX must not say:

```text
No internet. Try again.
```

It should say:

```text
Saved offline.
Will sync automatically.
```

---

# 30. Native mobile data architecture

Do not use Convex as if the phone permanently holds an open realtime connection.

Use:

```text
Convex
     ↓
Mobile sync boundary
     ↓
Local DB
     ↓
Application
```

For Android:

```text
Room
```

For iOS I would use:

```text
SQLite
```

via GRDB or a controlled Swift persistence layer.

SwiftData is attractive, but for a mission-critical offline synchronization engine, I would strongly prefer predictable SQLite semantics.

---

# 31. Local mobile database

Maintain local copies of:

```text
users
customers
outlets
products
priceLists
promotions
routes
coveragePlans
plannedVisits
orders
orderLines
tasks
truckInventory
```

plus:

```text
outbox
syncCursor
syncMetadata
```

---

# 32. Outbox pattern

Every offline mutation becomes:

```text
outbox

id
deviceId

operationType

entityType

entityId

payload

createdAt

attemptCount

status

idempotencyKey
```

Example:

```text
CHECK_IN
CREATE_ORDER
CHECK_OUT
PAYMENT
PHOTO
STOCK_SALE
```

When connectivity returns:

```text
outbox
 ↓
sync worker
 ↓
Convex mutation
 ↓
acknowledge
 ↓
remove/mark synced
```

---

# 33. Idempotency

Absolutely mandatory.

The same sale must never be created twice because:

```text
POST
timeout
retry
```

Each transaction gets:

```text
idempotencyKey
```

for example:

```text
deviceUUID + localTransactionUUID
```

Server stores the processed key.

Duplicate mutation:

```text
return existing result
```

instead of executing again.

---

# 34. Conflict strategy

Do not use one global merge policy.

Your repository already has an ADR dedicated to offline conflicts, which is exactly the right architectural mindset.

Different entities need different authority rules.

### Orders

Once submitted:

```text
append / status transition
```

Avoid free concurrent editing.

### Check-ins

Immutable event.

### Inventory movements

Immutable ledger.

### Customer profile

Last-write-wins may be acceptable for some fields.

### MCP

Server-authoritative.

### Product/pricing

Server-authoritative.

---

# 35. Mobile sync protocol

I would make sync explicit.

```text
mobileSync.pull({
    cursor,
    employeeId,
    deviceId
})
```

returns:

```text
changes
newCursor
serverTime
```

Then:

```text
mobileSync.push({
    deviceId,
    operations
})
```

returns:

```text
accepted
rejected
conflicts
serverTime
```

This is cleaner than making each mobile app independently understand dozens of Convex domain mutations.

---

# 36. Important Convex design decision

I would retain **Convex as the operational cloud system of record**, but introduce a stable mobile gateway domain:

```text
packages/backend/convex/mobile/
```

Something like:

```text
mobile/
  bootstrap.ts
  sync.ts
  visits.ts
  routes.ts
  orders.ts
  collections.ts
  devices.ts
```

The mobile apps shouldn't know your entire backend topology.

---

# 37. Bootstrap endpoint

At login/day-start:

```text
bootstrapMobileSession()
```

Return:

```text
employee
permissions
territory
todayPlan

customers

products

pricing

promotions

route

tasks

appConfig

syncCursor
```

This creates a deterministic local working set.

---

# 38. Don't synchronize the whole enterprise

A Cebu agent should not download:

```text
every customer
every route
every employee
every transaction
nationwide
```

Download their operational scope.

Example:

```text
assigned territories
assigned customers
neighbor customers if allowed
relevant products
relevant prices
current promotions
recent history
```

---

# 39. Mobile app authentication

You currently use Better Auth and invitation-only access.

Keep your identity authority, but introduce device registration.

```text
devices

id
employeeId

platform
IOS / ANDROID / VAN_ANDROID

deviceModel
osVersion

appVersion

registeredAt
lastSeenAt

status
ACTIVE
REVOKED
```

Supervisor/admin should be able to revoke devices.

---

# 40. Device binding

Optional but advisable.

After first authentication:

```text
account
  ↓
registered company device
```

Then credentials/tokens go in:

iOS:

```text
Keychain
```

Android:

```text
EncryptedSharedPreferences / Keystore
```

---

# 41. Role and permission model

Do not only use:

```text
ADMIN
USER
```

You need operational scopes.

Example:

```text
SUPER_ADMIN

SALES_DIRECTOR

NATIONAL_MANAGER

REGIONAL_MANAGER

AREA_MANAGER

SUPERVISOR

SALES_AGENT

MERCHANDISER

VAN_SALESMAN

VAN_CASHIER

DRIVER

WAREHOUSE

FINANCE

SALES_ADMIN
```

And permissions separately:

```text
coverage.view
coverage.edit
coverage.approve

order.create
order.override_price

visit.checkin

collection.create

van.load
van.sell
van.close_trip
```

---

# 42. Organizational scoping

A regional manager should see:

```text
their region
```

not necessarily nationwide.

Use:

```text
organizationalScopes
```

instead of hard-coded filtering.

---

# 43. SAP integration boundary

This is already one of the strongest architectural decisions in your repository.

You have an isolated SAP connector and versioned integration schemas.

Keep this rule:

```text
Mobile apps
       ↓
Convex
       ↓
SAP Connector
       ↓
SAP
```

Never:

```text
mobile → SAP
```

---

# 44. Integration ownership

You need a clear source-of-truth matrix.

I would start with:

| Entity                      | Authority   |
| --------------------------- | ----------- |
| Product                     | SAP         |
| UOM                         | SAP         |
| Customer accounting master  | SAP         |
| Price lists                 | SAP         |
| Credit terms                | SAP         |
| Inventory accounting        | SAP         |
| Outlet GPS                  | Turbo       |
| Coverage plan               | Turbo       |
| Route                       | Turbo       |
| Visit                       | Turbo       |
| Merchandising               | Turbo       |
| Field order                 | Turbo → SAP |
| Van transaction             | Turbo → SAP |
| Operational truck inventory | Turbo       |
| Accounting posting          | SAP         |

This distinction is critical.

---

# 45. Sales orders integration

Flow:

```text
Field Agent

↓ create order

Turbo

↓ validation

Approved/Submitted Order

↓ integration queue

SAP

↓ SAP document number

Turbo
```

Store:

```text
turboOrderId

sapDocEntry
sapDocNum

syncStatus
```

---

# 46. Do not make SAP calls synchronously during checkout

Bad:

```text
Salesperson presses Submit

↓
Turbo waits for SAP

↓
SAP unavailable

↓
order fails
```

Correct:

```text
Submit

↓
Convex confirms

↓
integration queue

↓
SAP connector

↓
eventual posting
```

Field operation continues.

---

# 47. Suggested backend folder evolution

You already have:

```text
domains/
salesForce.ts
```

That is going to become too large.

Move toward bounded domains:

```text
convex/

salesForce/
  employees.ts
  teams.ts
  territories.ts

coverage/
  plans.ts
  assignments.ts
  schedules.ts

visits/
  visits.ts
  checkin.ts
  activities.ts

customers/
  outlets.ts
  segmentation.ts
  location.ts

sales/
  orders.ts
  pricing.ts
  promotions.ts

vanSales/
  trips.ts
  loading.ts
  sales.ts
  reconciliation.ts

mobile/
  bootstrap.ts
  sync.ts
  devices.ts

analytics/
  coverage.ts
  productivity.ts
```

Keep inventory separated exactly as you already do.

---

# 48. Core Convex tables

At minimum:

```text
salesEmployees
salesTeams

regions
areas
territories

routes

coveragePlans
coveragePlanOutlets
coverageAssignments

plannedVisits
visits
visitActivities
visitLocationEvents

outlets
outletContacts
outletAttributes

tasks

salesTargets

vehicles
vanTrips
vanTripLoads

devices

mobileSyncOperations

collections

merchandisingAudits
```

Existing:

```text
products
customers
inventory
orders
```

should remain integrated rather than duplicated.

---

# 49. Event model

Use immutable events for business execution.

Examples:

```text
VISIT_CHECKED_IN

ORDER_CREATED

ORDER_SUBMITTED

PAYMENT_CAPTURED

VISIT_CHECKED_OUT

TRUCK_LOADED

VAN_SALE_COMPLETED

TRIP_CLOSED
```

Then analytics can be derived much more reliably.

---

# 50. Audit trail

For every important record:

```text
createdAt
createdBy

updatedAt
updatedBy

source

deviceId

version
```

For approvals:

```text
submittedAt
submittedBy

approvedAt
approvedBy
```

---

# 51. Route optimization

Do not build sophisticated optimization in V1.

MCP first.

The business likely already knows:

```text
who visits whom
what territory
what days
```

Start with:

```text
manual sequence
```

Then later use:

```text
distance optimization
travel duration
store time windows
priority
traffic
```

---

# 52. Mapping

I would support three concepts separately:

```text
Outlet Location
Route Path
Agent Activity
```

Don't store route polylines unless you actually need them.

V1 can simply:

```text
open navigation
```

using the installed map provider.

---

# 53. Background location

Use it conservatively.

I would not build V1 around continuous second-by-second GPS tracking.

Prefer:

```text
check-in location
check-out location
periodic route evidence while actively working
```

Continuous GPS tracking causes:

```text
battery drain
privacy concerns
OS background restrictions
massive event volumes
```

and delivers less business value than people expect.

---

# 54. Geospatial representation

For outlet point:

```text
latitude
longitude
```

For territories:

```text
polygon / GeoJSON
```

Possible future capabilities:

```text
customer inside territory
route clustering
coverage heat maps
unserved geographic areas
```

---

# 55. Image/photo architecture

Do not put photos directly inside records.

Use Convex file storage.

Record:

```text
visitPhoto

fileId

visitId

type

latitude
longitude

capturedAt
```

Types:

```text
STORE_FRONT
MERCHANDISING
PROMO_DISPLAY
INVENTORY
ISSUE
OTHER
```

---

# 56. Analytics model

Do not make every dashboard execute huge operational queries.

Eventually maintain rollups:

```text
dailySalesAgentMetrics

employeeId
date

plannedCalls

actualCalls

productiveCalls

orders

orderValue

collections

distanceTravelled
```

Same:

```text
dailyTerritoryMetrics
dailyCustomerMetrics
dailySkuMetrics
```

This matters once Sunpride has nationwide activity.

---

# 57. Dashboard

Management homepage should answer:

```text
How is today going?
```

not simply:

```text
Total users
Total products
Total customers
```

Example:

```text
Today's Sales

₱18.2M
92% of daily target
```

```text
Coverage

4,820 / 5,330
90.4%
```

```text
Productive Calls

3,940
81.7%
```

```text
Field Force

312 active
18 delayed
9 offline
```

---

# 58. Exception dashboard

This becomes especially valuable.

Show:

```text
Missed high-value accounts

Agents materially behind schedule

Repeated geofence failures

Orders awaiting SAP

Negative truck-stock exceptions

Cash discrepancies

Unclosed trips

Customers not visited within MCP frequency

Out-of-stock hotspots
```

Managers should manage exceptions rather than inspect every transaction.

---

# 59. AI layer

This is where your transition from software engineering to agent systems becomes useful, but I would not make AI the critical path for transaction processing.

The AI system should sit **above deterministic execution**.

Think:

```text
System of Record
Convex

↓

Operational Intelligence

↓

AI Agent
```

not:

```text
AI Agent
↓
controls transaction correctness
```

---

# 60. Initial AI capabilities

Phase 1:

### Sales Rep Copilot

```text
"What should I focus on today?"
```

Response:

```text
Three priority outlets

Gaisano Mabolo:
sales are 18% below 4-week average

Customer XYZ:
has not ordered Tender Juicy for 14 days

Metro Colon:
promotion ends tomorrow
```

---

# 61. Supervisor Copilot

Question:

```text
"Which of my people need attention?"
```

Agent evaluates:

```text
coverage

missed calls

order conversion

target

visit duration

territory performance
```

---

# 62. Management agent

Questions:

```text
Why is Cebu North below target?

Which territories are losing distribution?

Which customers stopped buying bacon?

Which SKUs have distribution gaps?
```

This becomes genuinely useful because the underlying SFA data is structured.

---

# 63. Route recommendation agent

Eventually:

```text
MCP
+
traffic
+
customer priority
+
historical conversion
+
time windows
+
inventory availability

→ suggested daily route
```

But the rep or supervisor remains the decision maker.

---

# 64. Technical mobile stack

Because you explicitly do not want cross-platform:

## iOS

```text
Swift
SwiftUI

GRDB / SQLite

URLSession

CoreLocation

MapKit

BackgroundTasks

Keychain

OSLog

XCTest
```

Architecture:

```text
MVVM
+
Repository
+
Use Cases
+
Sync Engine
```

---

# 65. Android field-sales

```text
Kotlin
Jetpack Compose

Room

Retrofit/HTTP boundary or Convex-compatible integration layer

WorkManager

Coroutines

Flow

Hilt

Google Play Services Location

CameraX
```

---

# 66. Android van sales

Same core platform:

```text
Compose
Room
WorkManager
Coroutines
Hilt
```

Additional:

```text
Bluetooth
ESC/POS
barcode scanner
device SDKs
USB
```

---

# 67. Shared code in a native world

Since you're deliberately choosing native, don't force business logic sharing through Kotlin Multiplatform.

Instead share:

```text
contracts
schemas
API specifications
test vectors
business rules documentation
```

For example:

```text
packages/domain-contracts/
```

could contain:

```text
JSON Schema
OpenAPI-like payload definitions
event schemas
validation fixtures
```

Swift and Kotlin generate or manually implement models from those.

---

# 68. What packages/ui should mean

Your existing `packages/ui` uses HeroUI and is React-specific.

Don't attempt to reuse that in mobile.

Split conceptual design from implementation.

```text
packages/design-tokens/
```

Contains:

```text
colors
spacing
typography
radius
semantic statuses
icons references
```

Then:

```text
packages/ui
```

remains web.

iOS/Android implement Sunpride styling natively.

---

# 69. Turborepo and native apps

Turborepo should orchestrate the JS/TS workspace.

Do not try to make Turbo fundamentally own Xcode/Gradle internals.

You can still expose root commands:

```json
{
  "scripts": {
    "dev:web": "...",
    "dev:backend": "...",

    "android:field": "...",
    "android:van": "...",

    "ios:field": "..."
  }
}
```

But:

```text
apps/field-ios
```

remains a normal Xcode project.

And:

```text
apps/field-android
apps/van-sales-android
```

remain Gradle projects.

---

# 70. Proposed mobile folder layouts

iOS:

```text
apps/field-ios/

SunprideField/
  App/

  Core/
    Networking/
    Database/
    Sync/
    Location/
    Auth/

  Features/
    Today/
    Route/
    Customers/
    Visits/
    Orders/
    Collections/
    Tasks/

  Domain/
    Models/
    Repositories/
    UseCases/

  UI/
    Components/
    Theme/

  Resources/

SunprideFieldTests/
```

Android:

```text
apps/field-android/

app/

core/
  database/
  network/
  sync/
  location/
  auth/
  designsystem/

feature/
  today/
  route/
  customer/
  visit/
  order/
  collection/

domain/
  model/
  repository/
  usecase/
```

---

# 71. Android van app

```text
apps/van-sales-android/

core/

feature/
  trip/
  loading/
  customers/
  pos/
  payment/
  printing/
  inventory/
  returns/
  reconciliation/
```

---

# 72. Van POS home screen

Example:

```text
TRIP 2026-09-09-CEB-014

Truck
V-014

Route
Mandaue North

Sales
₱73,400

Transactions
38

Truck stock
₱184,300

[ NEW SALE ]
```

---

# 73. POS checkout

Flow should be extremely fast.

```text
Select customer

↓

Scan/search product

↓

Qty

↓

Cart

↓

Payment

Cash
Credit
Other approved methods

↓

Confirm

↓

Print
```

Field POS users value speed over elaborate UI.

---

# 74. Cash reconciliation

At trip close:

```text
Expected cash
₱84,220

Declared cash
₱84,000

Difference
-₱220
```

Require:

```text
reason

supervisorApproval
```

if above tolerance.

---

# 75. Offline business guarantees

Explicitly define what works offline.

I would require:

| Function                           | Offline |
| ---------------------------------- | ------- |
| Login after first successful login | Yes     |
| Today schedule                     | Yes     |
| Customer lookup                    | Yes     |
| Check-in                           | Yes     |
| Order                              | Yes     |
| Visit                              | Yes     |
| Collection                         | Yes     |
| Photos                             | Yes     |
| Van POS                            | Yes     |
| Printing                           | Yes     |
| Truck inventory                    | Yes     |
| MCP edit                           | No      |
| Administrative approval            | No      |
| SAP status                         | Cached  |

---

# 76. Sync indicator

Every field app needs a persistent but unobtrusive status.

Example:

```text
✓ Synced
```

or:

```text
Offline
12 pending
```

or:

```text
Syncing 4 / 12
```

The user must always know whether the phone has safely transmitted transactions.

---

# 77. Data lifecycle

Field device does not need infinite historical data.

Example:

```text
current + next 14 days MCP
90-day order summaries
30-day visit history
active products
active promotions
```

Older data loaded on demand when connected.

---

# 78. Privacy

Because you're collecting employee geolocation, define this in the product itself.

Prefer:

```text
location capture during business workflows
```

rather than:

```text
24/7 tracking
```

Provide clear operational policy.

This matters both technically and organizationally.

---

# 79. Security

Your current repository already distinguishes sensitive SAP credentials from client applications, which should remain a hard rule.

Additionally:

```text
RBAC

scope enforcement server-side

device revocation

signed requests

audit logs

rate limiting

idempotency

no sensitive pricing/credentials in logs
```

---

# 80. Recommended release sequence

I would **not** try to build all of BeatRoute plus POS immediately.

Build vertically.

## Phase 0 — Domain discovery

Get actual Sunpride artifacts:

```text
current salesperson list

organization hierarchy

regions

territories

routes

customer master

product master

price lists

current route sheets

existing MCP

daily sales reports

van sales documents

truck loading sheets

cash reconciliation reports

SAP interfaces

BeatRoute screenshots/workflow from their employee
```

This phase will determine 70% of the correctness of the implementation.

---

# Phase 1 — Master Data + Organizational Model

Build:

```text
regions

areas

territories

sales teams

employees

roles

routes

customers

outlet GPS

products
```

Web only first.

---

# Phase 2 — MCP

Build:

```text
coverage plan

calendar

assignment

frequency

route sequence

approval

effective dating
```

This is your first significant Sunpride-specific deliverable.

---

# Phase 3 — Native Field MVP

Build both:

```text
field-ios
field-android
```

Only:

```text
authentication

bootstrap

Today

route

customer

check-in

visit

order

check-out

offline outbox

sync
```

Nothing else.

---

# Phase 4 — Supervisor Execution

Build:

```text
team performance

visit completion

exceptions

coverage analytics

route compliance
```

---

# Phase 5 — Order/SAP Integration

Operational flow:

```text
Field order

→ Convex

→ approval where needed

→ SAP connector

→ SAP order

→ status back to Turbo
```

---

# Phase 6 — Van Sales

Build Android-specific app:

```text
trip

truck loading

truck inventory

POS

payments

printing

returns

reconciliation
```

---

# Phase 7 — Merchandising

Add:

```text
assortment

availability

photos

surveys

display compliance

competitor data
```

---

# Phase 8 — Analytics

Add:

```text
coverage

strike rate

salesforce productivity

distribution

SKU performance

territory performance

customer performance
```

---

# Phase 9 — AI

Then introduce:

```text
Sales Copilot

Supervisor Copilot

Management Analytics Agent

Suggested Order

Route Suggestions

Anomaly detection
```

---

# 81. First MVP I would promise Sunpride

Don't promise:

> "We're building a BeatRoute replacement."

For first deployment, define it much more tightly:

### Sunpride Sales Execution MVP

```text
Master Coverage Planning

Territory and Route Management

Customer / Outlet Assignment

Daily Field Schedule

GPS-validated Check-in / Check-out

Visit Logging

Order Capture

Offline Operation

Supervisor Coverage Monitoring

SAP Sales Order Integration
```

That is already a very substantial product.

---

# 82. What I would specifically not build in the first release

Avoid:

```text
advanced AI

automatic optimized routing

continuous location tracking

gamification

complex commission system

chat

deep CRM

marketing automation

full BI platform

arbitrary workflow builder
```

Those distract from the execution loop.

---

# 83. The key architecture loop

The entire system can be understood as:

```text
PLAN
   ↓
ASSIGN
   ↓
EXECUTE
   ↓
TRANSACT
   ↓
VERIFY
   ↓
ANALYZE
   ↓
IMPROVE
```

More specifically:

```text
MASTER COVERAGE PLAN
        ↓
DAILY VISITS
        ↓
CHECK-IN
        ↓
SELL / COLLECT / MERCHANDISE
        ↓
ORDER
        ↓
SAP
        ↓
ANALYTICS
        ↓
NEXT COVERAGE PLAN
```

If every feature maps cleanly into that lifecycle, your architecture stays coherent.

---

# 84. One important adjustment to your repository

You already have an exceptionally large inventory implementation and substantial operational infrastructure—your `INVENTORY_SYSTEM_IMPLEMENTATION_PLAN.md` alone is already a major architecture document, while your backend contains separate inventory modules for POS, posting, counts, reservations, transfers, replenishment, manufacturing, receipts and reconciliation.

So I would **not start a second "sales system" beside it**.

Sunpride Turbo should instead become:

```text
                 SUNPRIDE TURBO
                       │
       ┌───────────────┼────────────────┐
       │               │                │
 Sales Execution    Distribution     Inventory
       │               │                │
       └───────────────┼────────────────┘
                       │
                     Orders
                       │
                      SAP
```

That is the architectural advantage of building this internally rather than buying BeatRoute.

BeatRoute handles sales-force execution.

**Sunpride Turbo can eventually understand the entire chain from inventory availability → route → customer visit → order → van sale → SAP → replenishment.**

That is much more valuable to Sunpride than cloning BeatRoute feature-for-feature.

### Repository changes I would make next

```text
DELETE / DEPRECATE
apps/pwa

ADD
apps/field-ios
apps/field-android
apps/van-sales-android

ADD
packages/domain-contracts
packages/design-tokens

EXPAND
packages/backend/convex/
    salesForce/
    coverage/
    visits/
    customers/
    vanSales/
    mobile/
    analytics/
```

And the **first new architecture document** should be:

```text
docs/architecture/
SALES_FORCE_AUTOMATION_IMPLEMENTATION_PLAN.md
```

with this blueprint as its starting point.

The most important next engineering artifact after that should be the **actual Convex entity/schema specification for MCP, territories, routes, visits, outlets, devices, mobile sync and van sales**, because once those boundaries are correct, the web UI and both native apps can be developed in parallel without diverging.
