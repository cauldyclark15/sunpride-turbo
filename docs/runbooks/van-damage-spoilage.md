# Van damage and spoilage (VAN-020)

How damaged or spoiled stock found on a van during the selling day is recorded, proven and
approved. Issue: SP-0114 (tracker VAN-020).

## What the salesman does (van-sales handheld)

1. Truck stock → the product → **Record damage**.
2. Enter the quantity and pick a reason: Crushed, Leaking, Expired, Spoiled or Other. Add a
   note if useful.
3. Take a photo when the screen asks for one (see the rules below). Retake if it is blurred.
4. Save. The quantity leaves sellable stock on the handheld at once, even offline. The photo
   uploads first on the next sync, then the record itself.
5. The Truck stock screen lists the day's damage records: Recorded, Waiting for supervisor,
   Approved, or Rejected — returned to sellable stock (with the supervisor's note).

## Rules (assumed defaults until Sunpride confirms its own)

| Rule                | Default                                                                                         | Where it lives                           |
| ------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Photo required      | Crushed, Leaking, Spoiled, Other; and every record that needs approval                          | `VAN_DAMAGE_POLICY.photoRequiredReasons` |
| Supervisor approval | One record of 12 or more whole selling units (about one case)                                   | `VAN_DAMAGE_POLICY.approvalFromUnits`    |
| Photo size          | JPEG, at most 90 KB after the handheld compresses it                                            | `VAN_DAMAGE_POLICY.photoMaxBytes`        |
| Who approves        | Manager or approver in the trip's unit (super admin anywhere); never the person who recorded it | capability `van.damage.approve`          |

All four sit in `packages/backend/convex/van/model.ts` and reach the handheld in the bootstrap
policy, so a change needs no app release.

## Stock and audit trail

- Every record posts one immutable movement on the truck: available → damaged
  (`van.truck.damage`, reason `van_damage:<reason>`). Damaged stock is never sellable and goes
  back to the depot as damaged with the evening leftover return.
- A record waiting for approval has already moved (the goods cannot be sold either way).
- **Approve**: nothing moves; the original movement stands as the write-off.
- **Reject** (a note is required): a separate damaged → available movement
  (`van.truck.damage.reject`) at the truck, or at the depot if the leftovers were already
  returned. The original movement is never edited.
- Every decision writes an audit log entry (`van.damage.approved` / `van.damage.rejected`).

## What the supervisor does (web)

Approvals → **Truck damage**: each waiting record shows product, quantity, reason, salesman,
trip, time, note and the photo (click to open full size). Approve, or type a note and Reject.

## Open questions for Sunpride

- Is 12 selling units the right approval threshold, or should it be a peso value per record or
  per day?
- Which reasons must always have a photo? Is "Expired" enough with the date on the label?
- Who approves: the area manager, the warehouse approver, or both?
- Should rejected damage be charged to the salesman (a shortage) instead of returned to stock?
- SAP posting of the write-off is out of scope this phase.
