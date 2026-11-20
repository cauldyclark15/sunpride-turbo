# Field master maintenance (SP-0230)

Open Setup > Field masters as a national administrator.

- Customer groups: add or rename a chain/key-account group and link or remove its stores. Enter your own reason for a group edit and for changing store links. This uses the same groups as Location / Customer group territory coverage; these groups are distinct from the customer's SAP classification lists.
- Channels: add a distribution channel under an existing sales organization or correct its name. This maintains the list used by the customer form and updates current customers' displayed channel names. Existing codes, selling taxonomy and price-list keys are not changed.
- Places: search the Philippine geography list by name or code. Rename a region, province, city/municipality or barangay; move a place by choosing its new parent. Codes are stable. New entries require an official ten-digit PSGC code. This screen is an administrative correction, not a claim that the PSA published a new official dataset.
- Re-map territory coverage in Setup > Territories using the existing Location / Customer group editor. Its coverage changes appear in the same change log.
- Change log: see Before, After, Reason, person and time. Filter by the list being maintained; use the page controls to reach earlier changes. Entries cannot be edited or removed. A repeat of an already successful request does not add another entry, and failed saves do not create change entries.
- Other field masters retains the existing versioned geography, selling taxonomy, beats, potential classes, must-stock and account hierarchy editors.

Place parent changes update the dependent municipality region and current customer geography, generated addresses and same-as-customer delivery addresses in the same transaction. Automatic territory assignments use the existing effective-dated assignment writer; previous assignment intervals and manual overrides remain intact. Parent changes affecting stores on protected approved/active coverage plans are refused without partial writes. Spelling corrections can still be saved without changing assignment facts or approved plan snapshots. Other free-text/custom delivery addresses are not rewritten.

Concurrent channel/place edits are refused when the displayed record has changed. Reload that list, select the record again, and re-enter the change. A missing reason, invalid parent, duplicate group/channel key or malformed PSGC code is refused without partial writes.

The new log starts recording when migration 0836 is applied. It does not invent before/after values for older changes; earlier version histories and audit records remain in their existing authorities. Only national administrators can read this cross-branch log or maintain the shared lists. Regional customer-group browsing and scoped territory maintenance retain their existing permissions.

Verification is in the API reference-maintenance / territory-coverage / customer-master / masters suites and the web reference-masters / territory-coverage / admin-workspace / module-workspace suites. These are synthetic isolated database and component proofs, not evidence of a production change or client acceptance.
