# Van POS hardware decision sheet (ARCH-022)

Status: recommended baseline, **provisional pending Sunpride hardware inventory and pilot**. This is not a declaration of Sunpride's installed fleet.

ADR-010 requires a separate native Android van-sales app on a handheld with an attached or integrated printer. The blueprint allows Bluetooth, USB or embedded SDK printing, camera/hardware/intent barcode scanning (§27), and a printer adapter rather than vendor lock-in (§28). ADR-003 requires one active device per truck route and a conservative offline stock projection.

## Information Sunpride must provide

| Checklist            | Requested detail                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handhelds            | Make/model/SKU, Android and security-patch versions, CPU/RAM/storage, battery and replaceable battery, ruggedness/IP rating, touchscreen/glove use, camera, NFC if needed; physical samples for QA.                               |
| Embedded peripherals | Built-in thermal printer model, command language and SDK/version; built-in scanner model, barcode formats, wedge/intent/SDK integration; available USB-C/OTG ports.                                                               |
| External printers    | Bluetooth printer make/model/firmware, pairing method, Bluetooth Classic/BLE support, concurrent-device constraints, charging and spare batteries; any USB printers.                                                              |
| Media and receipts   | Paper widths actually used (58 mm or 80 mm), printable width/dots, character/code page and peso symbol support, logo/QR/barcode, duplicate/reprint wording, receipt numbering, fiscal/legal fields and paper replacement process. |
| SDK and distribution | Vendor SDK binaries/docs/sample app, licenses, printer firmware tools, Android compatibility and lifecycle, MDM/enterprise app distribution, device enrollment/security policy.                                                   |
| Deployment           | Number of active trucks, devices per truck, spare ratio, regions/depots, intermittent connectivity locations, procurement schedule, pilot models, repair/spares and named hardware owner.                                         |
| Operating practice   | Load/route handover, shift charging, end-of-day cash and stock counts, printer failure fallback and lost-device escalation. Request existing van-sales documents (`docs/delivery/SFA_DELIVERY_SEQUENCE.md`, ARCH-007).            |

None of these details is established by the Sales Operations Standards memo. The memo's PMOT/route sales targets (§2) and reports (§6) do not specify hardware or legal receipt content; do not infer fleet quantities or receipt requirements from them.

## Recommended engineering baseline, not a procurement commitment

- Android 12+ rugged handheld with current vendor security maintenance, hardware-backed Keystore, full-disk encryption, managed deployment, sunlight-readable screen, 4 GB RAM / 64 GB storage minimum, all-day battery plus charging in truck, usable camera scanner. Prefer an integrated 58 mm thermal printer for fewer pairing points; test an 80 mm external printer where the actual receipt requires it. Exact OS minimum and management policy are provisional per ADR-020.
- Start with a vendor-neutral `ReceiptPrinter` adapter and ESC/POS over Bluetooth Classic (or USB when supported), 58 mm layout baseline, explicit connection/print/error and reprint handling. Keep vendor embedded SDK adapters separate. **Do not assume every integrated printer accepts ESC/POS.** Validate raster graphics, Unicode/code page, pesos, cut behavior, QR/barcodes and printer status on real models before buying. Blueprint §§27–28.
- Scanner abstraction accepts camera and hardware scan intents without requiring a network call. Test sales, receipt printing and end-of-day count in airplane mode with the same route/stock sequence (ADR-019); persist sale before invoking a printer, so a print failure offers a controlled reprint without a second sale.
- Pilot at least one unit of each candidate printer/scanner combination and an actual truck's shift. Acceptance: offline scan to printed receipt, readable legal content approved by Sunpride, repeated Bluetooth reconnect, battery endurance, MDM revoke/replacement, printer-out-of-paper recovery and no duplicate sale on reprint.

**Open hardware questions not covered by Client questions 1–12:** actual fleet/models and quantities, SDK/firmware access, paper/receipt legal format, MDM ownership, and printer-failure fallback. Resolve these before a vendor adapter or procurement is finalized.
