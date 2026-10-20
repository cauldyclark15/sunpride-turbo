# Device fleet and rollout plan (F-021, operations side)

Status: **our recommendation, not a purchase order.** The spec (F-021) asks for rugged device selection, mobile printer, scanner, data plan, MDM enrolment, spares pool, break-fix SLA and charging discipline in vans. Sunpride and its partner buy, enrol and run the fleet; the software side (the fleet register in the office app: devices, who has them, printers and scanners, MDM status, data plan, spares and repairs) is built in Wave A by the Integrity lane.

Performance and battery targets the devices must meet are in `nfr-baseline.md` (F-025).

## F-021.1 Field phones (reps, merchandisers, supervisors, census crews)

**Floor: the Redmi A7 Pro class.** We chose it on purpose as an entry-level phone like the ones field reps carry, and every Android change is measured on it.

|                  | Minimum                                                      | Why                                                                   |
| ---------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| Android          | 12 or later, with security updates for at least 2 more years | Supported range in F-025.8                                            |
| Memory / storage | 4 GB RAM / 64 GB                                             | App uses about 85 MB in normal work; room for photos and offline data |
| Network          | 4G, dual SIM                                                 | Second SIM slot allows a backup network in weak areas                 |
| Location         | GPS with GLONASS or Galileo                                  | Check-in and census pins within 50 m                                  |
| Camera           | 8 MP rear, autofocus                                         | Storefront, shelf and proof photos                                    |
| Battery          | 5,000 mAh or more                                            | One 10-hour shift with location sharing                               |
| Screen           | 6.5 inch or larger, readable outdoors                        | Long product lists, sunlight                                          |
| Protection       | Rugged case and screen protector, bought with the phone      | Cheaper than repairs                                                  |

A phone above the floor is fine. A phone below it is not supported, because the performance targets are proven only from the floor up.

## F-021.2 Van handhelds and printers

- **Recommended: a rugged Android handheld with a built-in 58 mm thermal printer and barcode scanner**, the Senraise H10P class. One device, no pairing, the scanner reads case and piece barcodes. The van app is tested on the H10P today.
- Alternative: a floor phone plus a Bluetooth 58 mm printer. Supported, but adds pairing failures and a second battery; use only where a built-in printer is not possible.
- Paper: 58 mm thermal rolls, **two spare rolls in every van**, and a low-paper check at load-out. The app never prints when the printer cannot confirm paper; it keeps the sale and offers a reprint.
- Receipt wording, document series and BIR fields depend on the BIR Permit to Use (F-018, F-019). Until the permit is approved, receipts say they are not official receipts.

## F-021.3 Data plans

- One postpaid business data plan per device, **3 GB a month** (the targets in F-025.5 put normal use well under 1 GB). Pick the network with the best coverage on the actual routes; dual-SIM phones carry a second network's SIM in weak areas.
- Block personal video streaming on the plan or through MDM to protect the allowance.
- First sign-in and app updates over office Wi-Fi.

## F-021.4 Device management (MDM)

- Enrol every device in an Android Enterprise MDM (for example Google's own Android management, or the vendor's tool for the handhelds) **before** it reaches the user.
- Policies: screen lock required; install only from the managed store; our two apps pushed and kept updated by MDM; developer options and USB debugging off; remote lock and wipe on.
- The apps add their own protection on top: one registered device per user, refusal of rooted or tampered phones, fake-GPS detection, and the office can suspend or remove a device (F-007, F-024).
- The MDM status of each device is imported into the fleet register so the office sees, in one place, who has which device and whether it is healthy.

## F-021.5 Spares and repairs

- **Spares pool: 10% of each model**, at least two per depot, enrolled and ready to hand out.
- Break-fix rule: a broken device is swapped from the pool **the same day** at the depot, or by the next morning for remote routes. Unsynced work stays safe on the old device: it is synced or recovered before the device is wiped, never thrown away.
- Repairs go back to the supplier under a written repair time (we suggest 5 working days), tracked in the fleet register.
- A lost or stolen device is suspended in the office app and wiped through MDM the same day.

## F-021.6 Charging discipline

- **Van:** every handheld is fully charged at load-out (checked on the load-out checklist), has a 12 V in-truck charger fitted, and a charged spare battery or power bank. The trip cannot start below 80% battery.
- **Field reps:** phone fully charged each morning; a 10,000 mAh power bank issued with each phone; Battery Saver allowed (the app is tested with it on).
- Phones charge overnight at home or in a depot charging rack; depots get one rack per 20 devices.
- Supervisors check charge at the morning huddle for the first two weeks of each rollout.

## F-021.7 Rollout sequence

| Step | When                    | What                                                                                                           |
| ---- | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1    | Wave 0                  | Buy pilot units: 3 floor phones, 2 handhelds. Run the full 12-hour SIM-out route (F-025.2) on them.            |
| 2    | Wave 0                  | Census crews get their phones (F-011).                                                                         |
| 3    | Wave 1 pilot            | One depot, about 10 vans: handhelds, printers, data plans, MDM, spares, chargers fitted.                       |
| 4    | Wave 1 scale and Wave 2 | Remaining vans, then field reps, depot by depot, each with a one-day training and the two-week charging check. |

## Needs Sunpride

- Device count by role and depot, the procurement owner and budget, and whether any existing devices should be reused (they must meet the floor).
- Choice of MDM and who runs it.
- Network provider and plan.
- The BIR Permit to Use (receipt content and number ranges for printing).
