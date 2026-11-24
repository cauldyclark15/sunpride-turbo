# SP-0242: Postal-code reference repair

## Result and limits

The committed PSGC 3Q-2026 reference originally had 1,703 municipality/postal pairs covering 1,495 of 1,655 municipalities/cities. An audit found 160 municipalities with no postal entry.

`packages/db/reference/ph-postal-repairs-sp242.json` adds 166 government-source-backed pairs for 152 of those municipalities. The combined reference has 1,869 pairs covering 1,647 municipalities. Original published pairs are retained unchanged. Corrections include Cebu, Bohol, Negros, renamed places such as Baliwag and Sawata, new municipalities with published postal numbers, Manila districts, and Marikina's 12 postal areas.

No customer address or saved postal value is rewritten. Pairing uses explicit PSGC identifiers and reviewed province/name aliases, never nationwide fuzzy matching, inferred numbering, or a former parent's ZIP number.

## Sources and reproducibility

The repair JSON identifies the source and original table label of each entry; PDF entries also identify the PDF page. Its `sources` section records public source URLs, including:

- PHLPost's ZIP Code Locator, already captured in `phlpost-zip-locator-raw.json`.
- DBM's Philippine Government Directory, 2025 Update, Municipal Governments. PDF SHA-256 is recorded in the JSON. Printed pages and PDF page numbers differ; the JSON uses PDF page numbers.
- Marikina City Government's 2023 Facts and Figures, with a barangay/postal table attributed to the Marikina Central Post Office. PDF SHA-256 is recorded in the JSON.
- Published government-office postal addresses for the remaining city/district mappings. Sawata's name association is documented by Republic Act No. 11814 in the Senate legislative library.

The original PSGC and postal snapshot is not modified. The revised loader combines it with the explicit repairs and changes the geography release identifier independently of the PSGC quarter.

Verify that the checked-in additive SQL matches the reviewed repair:

    bun packages/db/scripts/build-ph-postal-repairs.js --check

The generator is for this immutable repair. Future reference changes need a new revision and a new migration, not edits to an already-applied migration.

## Applying the repair

Use only the authorized deployment's normal migration procedure, with its connection supplied securely. Migration `0849_ph_postal_repairs.sql` adds missing postal keys to already populated installations and records the revised release. It is additive and safe to repeat; it neither replaces existing entries nor changes customer records. On an empty installation, the normal `seed-ph-geography.js` loader supplies the combined reference later.

The loader no longer treats an unchanged PSGC release and barangay count as proof that the postal list is complete. It checks expected municipality/postal keys, so a missing pair is repaired even when an unrelated extra pair keeps the total row count unchanged.

This task only prepares the migration and Android change on its issue branch. It does not apply anything to the public site or install anything on phones.

## Field-app cache

The old Android path returned the nationwide postal pack from cache for up to 30 days, hiding corrected reference entries even while online. The revised path downloads that pack when customer setup is opened, saves it when possible, and falls back to the previous pack without a connection. The much larger per-province barangay lists keep their existing 30-day cache. A cancelled load remains cancelled.

Existing installed Android versions retain their old cache policy until the updated app is distributed. This change does not clear drafts or recorded work and requires no phone reset. No phone installation or physical-device behavior is claimed by the local build/unit checks.

## Unresolved places: do not invent postal numbers

The DBM 2025 directory's Special Geographic Area table (PDF page 260, printed page 258) explicitly shows `----` rather than a ZIP number for these eight municipalities:

| PSGC identifier | Municipality |
| --------------- | ------------ |
| 1999901000      | Kapalawan    |
| 1999902000      | Old Kaabakan |
| 1999903000      | Kadayangan   |
| 1999904000      | Nabalawag    |
| 1999905000      | Pahamuddin   |
| 1999906000      | Malidegao    |
| 1999907000      | Ligawasan    |
| 1999908000      | Tugunan      |

This is evidence of an unpublished number in that source, not proof that PHLPost has never assigned one. No number is guessed, copied from a neighboring/former-parent municipality, or added for these towns. An affected address and confirmed postal number are needed before mapping one of them. The original issue gives no specific affected municipality, so matching the reported field case remains unverified.

## Focused retest after publication

1. Office: Customers > Add customer. Select Cebu > Barili and confirm postal number 6036 is available; save and reopen one authorized customer.
2. Confirm San Remigio in Cebu offers 6011 while San Remigio in Antique offers 5714. Confirm Cortes in Bohol offers 6341 and Cortes in Surigao del Sur offers 8313.
3. Updated Android app: Customers > Add customer while connected. Confirm the corrected postal entry appears even if an earlier list had already been saved on the phone. Reopen without a connection and confirm the downloaded entry remains usable.
4. Ask the reporter for their affected municipality/address or screenshot. If it is one of the eight unresolved towns, confirm the postal number before adding it; do not waive location/postal validation or invent a value.
