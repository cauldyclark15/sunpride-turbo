# H10P printer and scanner (VAN-014 / VAN-016)

## Integration contract

`ReceiptPrinter` is vendor-neutral. `PrinterRegistry.select(context)` selects
`SenraiseEmbeddedPrinter` only when `recieptservice.com.recieptservice` is installed;
otherwise it returns `NoPrinter` (`Unavailable`), **not** a silently successful fake.
`FakeReceiptPrinter` is explicitly injectable for tests. The lifecycle owner closes the
printer; close is terminal. A new adapter can reconnect after closing. Binder death or
service disconnect makes status `Disconnected`; an explicit connect rebinds.

Documents support styled text (alignment, bold, double width/height), two-column rows,
dividers, QR, barcode and feed. The 58mm formatter uses 32 normal cells, 16 double-width
cells, wraps words/oversized tokens and never crops amounts. Amounts are exact decimals
with ASCII `P`, never floating point. Unicode code points are not split, but full-width
CJK/emoji character-cell widths are not guaranteed by vendor fonts.

`ReceiptPrinting.saveThenPrint(save, build)` enforces the **persist-first** rule: save
must complete durably before connecting/printing. Printing failure never undoes the
saved sale or submits it twice. Explicit `reprint` adds a prominent `REPRINT` banner and
never saves a second sale. An error with `mayHavePrinted=true` must not be auto-retried.

The H10P has **no cutter and no cash-drawer port**. Both operations return `Unsupported`.
Use `ReceiptElement.Feed(3)`/`Feed(4)` and manually tear the paper. ESC/POS Bluetooth is
intentionally not implemented: the registry contains a named `TODO(VAN-015)` selection
hook for that later lane.

## Sale receipts, reprint and printer check (VAN-017)

**Original and reprint.** After Complete sale saves the sale, the original prints automatically
(`ReceiptPrintFlow`, persist first). Every attempt is first written to the encrypted, scoped
`receipt_print` table (DB v3, `MIGRATION_2_3`) as `started`, then finished once as `printed`,
`not_printed` or `maybe_printed`. Only `not_printed` (printer refused before `beginWork`) leaves the
original available; `started` (app died mid-print), `maybe_printed` and `printed` all count as on
paper, so any further copy is a reprint. An automatic print never reprints.

**Authorized reprint.** A reprint needs an explicit seller request (Receipts or Sale saved → Reprint)
with one of the reasons in `ReprintRules.REASONS`, and is allowed only for:

- a sale in the signed-in seller's own store scope (full auth subject + registered device),
- on the trip the phone is on now (older receipts: ask the office),
- while the phone's work is not held, and
- at most `ReprintRules.MAX_REPRINTS` = 3 reprints per sale.

These are our defaults until Sunpride sets its own reprint policy (who may reprint, how many, and
whether a supervisor must approve); they live in one object so the office policy can replace them.

**Marker.** A reprint prints a `REPRINT` banner first (formatter), `REPRINT - COPY n` in the header,
and at the end `Reprinted: <Manila time>`, `Reason: <label>` and `** REPRINT - NOT ORIGINAL **`.
Printing writes only print history: the sale, lines, payment, stock movements and frozen outbox bytes
are never touched. Print history is local only for now; it travels with the sale upload once the
van gateway accepts sales.

**Receipt layout** (`SaleReceiptDocuments`, 32 columns): SUNPRIDE VAN SALES / DELIVERY RECEIPT,
receipt number, sale date (Manila), customer, seller, trip, truck, each item with quantity × unit
price and line total, TOTAL, cash and change (or method and amount), reference, payment state and
due date, QR of the receipt number, and the non-BIR disclaimer. Amounts use ASCII `P`.

**Printer check.** `ReceiptPrinter.diagnostics()` returns connection, paper and (H10P) the scanner
hint. The H10P vendor ABI has **no paper query**: its paper callback (`VersionCallback.paper`) is
internal to the service (registered on its own `Sendlnterface`), which shows its own "no paper"
dialog. So the check reports paper as **Not reported by this printer** rather than claiming it is
loaded. An adapter that can sense paper (e.g. VAN-015 ESC/POS) reports `OUT`, and printing is then
refused before anything is recorded. The screen also shows the last receipt print result of the
session, and Check printer reconnects.

## AIDL recovery and compatibility

The installed vendor APK is `/system/priv-app/SRPrinter/SRPrinter.apk`, package
`recieptservice.com.recieptservice`, versionName `8.3.6`, versionCode `209` on this H10P.
The deliberately misspelled `recieptservice` must be preserved exactly.

Recovery procedure (use SDK build-tools `dexdump`; scratch directory, not the repo):

```sh
adb -s H10P756265T0744 pull /system/priv-app/SRPrinter/SRPrinter.apk "$HOME/.hermes/cache/scratch/h10p/SRPrinter.apk"
unzip -o "$HOME/.hermes/cache/scratch/h10p/SRPrinter.apk" 'classes*.dex' -d "$HOME/.hermes/cache/scratch/h10p"
"$ANDROID_HOME/build-tools/36.0.0/dexdump" -d "$HOME/.hermes/cache/scratch/h10p/classes3.dex" > "$HOME/.hermes/cache/scratch/h10p/c3.txt"
"$ANDROID_HOME/build-tools/36.0.0/dexdump" -d "$HOME/.hermes/cache/scratch/h10p/classes7.dex" > "$HOME/.hermes/cache/scratch/h10p/c7.txt"
```

`PrinterInterface$Stub$Proxy` writes the descriptor
`recieptservice.com.recieptservice.PrinterInterface`, calls `transact(code, data, reply, 0)`
and reads exceptions. Calls are **two-way**, not `oneway`. `Stub.onTransact` was also
checked: QR reads String/int/int in that order; barcode reads String/int/int/int; text
size/line height are float; boolean methods marshal int; table reads String[]/int[]/int[].
Proxy and service local-variable tables confirm QR `(data, modulesize, errorlevel)` and
barcode `(data, symbology, height, width)`, so no argument reordering was needed.

| Code | AIDL method                                                |
| ---: | ---------------------------------------------------------- |
|    1 | printEpson(byte[])                                         |
|    2 | getServiceVersion() -> String                              |
|    3 | printText(String)                                          |
|    4 | printBitmap(Bitmap)                                        |
|    5 | printBarCode(String, int symbology, int height, int width) |
|    6 | printQRCode(String, int moduleSize, int errorLevel)        |
|    7 | setAlignment(int), 0 left / 1 center / 2 right             |
|    8 | setTextSize(float)                                         |
|    9 | nextLine(int)                                              |
|   10 | printTableText(String[], int[] weight, int[] alignment)    |
|   11 | setTextBold(boolean)                                       |
|   12 | beginWork()                                                |
|   13 | endWork()                                                  |
|   14 | setDark(int)                                               |
|   15 | setLineHeight(float)                                       |
|   16 | setTextDoubleWidth(boolean)                                |
|   17 | setTextDoubleHeight(boolean)                               |
|   18 | printPDF417Code(String, int width, int height)             |
|   19 | setCode(String charset)                                    |
|   20 | print128BarCode(String, int type, int height, int width)   |
|   21 | getScannerStatus() -> boolean                              |

Vendor PSAM transactions 22–25 are intentionally omitted at the end, so earlier codes
are unchanged. Do **not** reorder this AIDL alphabetically. Declaration order is the
wire ABI. Native QR uses transaction 6; supported 1D barcodes are validated and rendered
with ZXing to a maximum 384-dot bitmap before `beginWork`, avoiding undocumented native
symbology-number differences. The AIDL still exposes codes 5/20 for compatibility.

Bind with an explicit Intent:

```kotlin
Intent().setPackage("recieptservice.com.recieptservice")
    .setClassName("recieptservice.com.recieptservice",
        "recieptservice.com.recieptservice.service.PrinterService")
// context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
```

The existing AndroidManifest `<queries><package
android:name="recieptservice.com.recieptservice"/></queries>` is necessary for Android 11+
visibility. CAMERA permission and optional camera feature were already present; this
lane did not add manifest entries. No Bluetooth permissions are needed for the embedded
printer.

All AIDL calls, binder liveness/version checks, death linking/unlinking and print commands
run on `Dispatchers.IO`. A five-second bind timeout returns `Timeout`. Missing packages
or failed service resolution return `ServiceMissing`; connection/death errors return
`Disconnected`; other exceptions become `Failed(message)`. Jobs are serialized, including
across adapter instances in one process, and bracketed by `beginWork/endWork` with cleanup
on partial failure. Synchronous vendor Binder calls are not forcibly cancellable; the
bind timeout is **not** represented as a physical print deadline.

`Ready` means a connected service, **not** confirmed paper/temperature readiness. The
vendor posts print/render work to a Handler, so `PrintResult.Success` means all commands
were accepted without a Binder exception, not a completion ACK or a paper-out check.
Vendor VersionCallback paper/error/ready support is optional and not implemented here.

## Peso-sign finding

Production currency uses **ASCII `P`** (e.g. `P374.50`), and
`PrinterCapabilities.pesoGlyphVerified` remains false. The real-device test includes an
explicit `GLYPH PROBE ONLY: P PHP ₱` line. A successful print command is not proof that the
physical peso glyph is legible: inspect that line on paper before claiming support or
changing the capability flag. No visual glyph confirmation is available to this lane.
The printer must not silently switch production amounts to `₱` based on service success.

## Unified scanning

All three paths use `BarcodeInputs` / `BarcodeSource.scans: Flow<ScanEvent>`, with source
`BROADCAST`, `WEDGE` or `CAMERA`. Same-code arrivals across sources within 300ms are
suppressed, even if another barcode arrives in between. A same code at/after 300ms is an
intentional new scan. Time uses a monotonic clock. Only vendor CR/LF suffixes are removed;
identifier whitespace otherwise remains unchanged. Blank/over-4096-character input is
rejected. Events are ephemeral (not sale mutations, not a durable queue).

### Hardware broadcast

`classes7.dex`, `Scan.postScanResult`, constructs
`Intent("android.scanner.scan").putExtra("result", code)` and sends it to other apps.
`SenraiseScanner.start()` dynamically registers that exact action, with
`Context.RECEIVER_EXPORTED` on API 33+, since the sender is a different package. Stop it
when the screen is not visible. This action has no vendor signature permission; treat
all scan strings as untrusted product lookup input, not authentication or authorization.
`queryScannerStatus(printer)` optionally reads transaction 21 after printer connect;
null means the query was unavailable, not that scanning is disabled.

### Supported hardware scanner intents (VAN-009)

`SenraiseScanner` registers every action in `ScanIntentProfiles.SUPPORTED` while a scan screen is
visible; `ScanIntentProfiles.extract` reads the code from String extras, or from a byte[] extra
honouring a declared length (a bogus length falls back to the array, trailing NULs removed).
Unknown actions, wrong extra types and unreadable parcels yield nothing.

| Device / mode                                      | Action                                        | Extra(s)                                                | Status                     |
| -------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| Senraise H10P                                      | `android.scanner.scan`                        | `result`                                                | verified on the H10P       |
| Senraise / Urovo legacy firmware                   | `scan.rcv.message`                            | `barocode` (byte[]) + `length`, or `barcode_string`     | vendor default, unverified |
| Urovo                                              | `android.intent.ACTION_DECODE_DATA`           | `barcode_string`, or `barocode` + `length`              | vendor default, unverified |
| Sunmi                                              | `com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED` | `data`                                                  | vendor default, unverified |
| Newland                                            | `nlscan.action.SCANNER_RESULT`                | `SCAN_BARCODE1`                                         | vendor default, unverified |
| iData / Kaicom                                     | `android.intent.action.SCANRESULT`            | `value`                                                 | vendor default, unverified |
| Configurable (Zebra DataWedge, Honeywell, generic) | `com.sunpride.van.SCAN`                       | `barcode`, `com.symbol.datawedge.data_string` or `data` | configure the device       |

For a configurable scanner set its output to **Intent / Broadcast**, action
`com.sunpride.van.SCAN`, and the barcode in extra `barcode` (DataWedge's default
`com.symbol.datawedge.data_string` also works). Keyboard-wedge mode needs no setup: on
Find product the search field accepts the typed code and Enter treats it as a scan.

Resolution (`pos/BarcodeLookup`): exact barcode, then the same GTIN in another length, then a
GS1 AI (01) element string with a valid check digit, then an exact product code. Each match
carries the barcode's unit from the bootstrap `barcodeUnits` (backend `productBarcodes.uomId` and
the in-force `uomConversions`), so a case barcode is never counted as one piece. Unknown codes
show **Barcode not found** with Search by name / Use camera; a barcode on several products lists
them all. UPC-E is matched only as sent: set scanners to transmit UPC-E expanded to UPC-A.

### Keyboard wedge and vendor settings

The APK resource table and `Scan.postScanResult` confirm independent broadcast/keyboard
switches: `MyApplication.isA` gates broadcasting, `isB` gates injected KeyCharacterMap
key events, and `isD` appends newline. Both paths may be enabled simultaneously. The
launcher/exported settings activity is
`recieptservice.com.recieptservice.SettingsActivity`.

Open the vendor settings app, choose **Scanner** / **Scan Setting**, and look for these
exact English labels recovered from its resources (firmware/localization may differ):

- **Broadcast Mode Enter scan data**: enable for broadcast mode; recommended for this app.
- **Keyboard input scan code data**: enable for wedge mode.
- **Enable appending \\n** (or **Enable appending \\r**): enable an Enter/newline terminator
  for wedge completion.
- **Clear previous scan data**: optional vendor pre-scan deletion; supported by the wedge
  buffer's backspace handling.

These labels are APK resource findings, not a claim that this lane changed the device's
settings. For wedge mode focus `WedgeScanField` before pressing the physical scan button.
`Modifier.captureBarcodeWedge(inputs)` consumes printable key-down characters in that
field, emits at Enter, ignores repeat/up events and resets stale partial bursts after
250ms. Do not attach this modifier globally to customer/password/quantity fields. An
oversized burst is discarded completely instead of emitted with a truncated barcode.

### Camera fallback

`CameraScanScreen` requests CAMERA at runtime and provides an explicit permission/error
message plus back button when access is denied/unavailable. It uses lifecycle-bound
CameraX Preview + ImageAnalysis (`KEEP_ONLY_LATEST`) and ZXing MultiFormatReader, supporting
EAN-13/EAN-8/UPC-A/UPC-E/Code128/QR. It honors Y-plane row/pixel stride and buffer position,
tries a rotated frame for vertical linear codes, always closes ImageProxy, and only
unbinds its own use cases on exit. No Play services, cloud image uploads, or decoder
network calls. The first decoded code returns to settings and joins the same dedupe bus.
Camera permission/live capture is implemented; unit tests exercise real generated
ZXing images, not a claim of a physical camera scan on this device.

## Standalone UI wiring

Supply `PrinterTestScreen(printer, scanner)` from the future settings/navigation owner:

```kotlin
val printer = remember { PrinterRegistry.select(context) }
val scanner = remember { SenraiseScanner(context) }
DisposableEffect(printer, scanner) {
    onDispose { scanner.close(); printer.close() }
}
PrinterTestScreen(printer, scanner)
```

It has a monochrome Material3 theme, system-bar Scaffold padding, 56dp-minimum buttons,
service status, test print feedback, last scanned code/source, focused wedge field and
camera entry. Printing a test receipt does not save a sale. The footer is exactly:
**Delivery receipt only. Not a BIR official receipt.** Navigation wiring is owned by the
other lane; this lane did not edit MainActivity or add a temporary launcher.

## Verification

Unit tests cover 32-cell wrapping/no character loss, double-width limits, columns,
oversized amounts, exact currency, test receipt metadata/QR/disclaimer, save-before-print,
reprint/fake/no-printer behavior, wedge timeout/overflow and dedupe, real ZXing image
recognition and padded Y-plane extraction.

Device tests must only run through the locked helper (never an emulator or
`connectedDebugAndroidTest`):

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
~/.hermes/scripts/sunpride-pos-device-test.sh /Users/jc/cnc/.worktrees/sunpride-van-pos
```

`SenraisePrinterDeviceTest.bindsRealServiceAndPrintsRealTestReceipt` binds the real service,
reads/logs its version, prints the real non-official receipt with QR and glyph probe,
asserts `PrintResult.Success` and waits for the vendor render queue. It assumes/skips only
when the vendor package is absent. `SenraiseScannerBroadcastTest` registers the exported
receiver, sends `4800000000017` from the test and checks code/source from the actual Flow.
The broadcast test proves Android registration/transport, not a physical optical scan.

## Executed evidence

The final verification command in `apps/van-sales-android` was:

```sh
./gradlew assembleDebug testDebugUnitTest lintDevDebug
```

Exit **0**; tail:

```text
> Task :app:lintDevDebug

BUILD SUCCESSFUL in 21s
60 actionable tasks: 3 executed, 57 up-to-date
```

The requested unflavored `./gradlew assembleDebug testDebugUnitTest lintDebug` initially
exited **1** because `lintDebug` is ambiguous in this dev-flavored project (the concrete
task is `lintDevDebug`). Gradle files are outside this lane's ownership, so no task alias
was added. A transient compile failure in the concurrently edited storage/sync lane was
left untouched and resolved on retry. Latest unit XML reports contain **94 tests, 0
failures, 0 errors, 0 skipped**, including **24 printing/scanning tests**.

The locked device helper exited **0** on the attached `H10P756265T0744`. Final output:

```text
Installed on 1 device.
Installed on 1 device.
== com.sunpride.van.dev.test/androidx.test.runner.AndroidJUnitRunner
OK (22 tests)
```

Full instrumentation log:
`/Users/jc/.hermes/cache/scratch/sp-lanes/pos-test-sunpride-van-pos-224057.log`.
Parsed final statuses: **22 passed, 0 failed, 0 skipped**. Both owned instrumentations
returned `INSTRUMENTATION_STATUS_CODE: 0`:

- `SenraisePrinterDeviceTest#bindsRealServiceAndPrintsRealTestReceipt`
- `SenraiseScannerBroadcastTest#receivesExportedVendorBroadcast`

Real-device logcat evidence:

```text
REAL_PRINTER_SERVICE_VERSION=209 MODEL=H10
REAL_SCANNER_STATUS=false
REAL_TEST_RECEIPT_PRINT_RESULT=Success; PESO_PROBE_SENT=P PHP ₱; GLYPH_VISUAL_CONFIRMATION_REQUIRED
```

Android reports model `H10` on the attached H10P. `getScannerStatus()` returned **false**;
its vendor implementation reads `MyApplication.has_scan`. This is an availability hint,
not proof that the optical engine is absent or an indication of which output mode is
selected. No vendor settings were changed. Broadcast transport passed independently of
that hint; physical trigger/optical capture and the physical peso glyph remain visually
unconfirmed. The real receipt was sent through the real embedded service and its test
asserted Success, as required; physical paper-out completion ACK is not provided by this
vendor ABI.
