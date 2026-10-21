# Reviewed commercial models

The Demand signals workspace contains **Reviewed shelf and ordering models**. These are assistive suggestions, not stock, order, payment or verified shelf writes.

## Suggested orders

1. Add reviewed examples for one outlet and product. Record the source and its permission/consent, observation time, retention end and sample/operational provenance.
2. All quantities use the product's frozen base-unit representation. Inputs are earlier purchase daily quantity, observed daily offtake, annual seasonal sine/cosine, governed promotion uplift percent, observed stock and cover days. The target is actual next-order base quantity. Do not include future outcomes in input features.
3. Choose at least eight earlier training examples and two strictly later temporal holdouts. The local ridge-regression implementation trains only on training rows and compares held-out mean absolute error with the existing cover-day rule.
4. A different authorized master-data editor approves a candidate only when its holdout error improves the rule. This is not a certification of production accuracy.
5. The shared availability snapshot used by web and both existing native products substitutes the approved model only for the matching current outlet/product owner, retained dataset and complete fresh observations. Otherwise it keeps the existing rule. Sample models apply only to sample outlets. The proposed quantity is still editable; it never posts an order.
6. Run a reviewed example and record an independent acceptance, correction or rejection. Original prediction and append-only reviews remain separate. Corrected examples may be entered into a later dataset; no automatic retraining changes a published version.

Season features use `angle = 2π × ((UTC epoch day mod 365.25) / 365.25)`. Stored model versions freeze normalization, weights, source hash, examples and holdout measurements. Operational annotations are source-declared reviewed inputs, not an assertion that arbitrary uploaded numbers were independently verified against SAP.

## Shelf recognition

No detector weights or production accuracy are bundled. Without a configured detector, inference explicitly reports unavailable and the manual workflow remains authoritative.

The server operator sets `SUNPRIDE_SHELF_MODEL_COMMAND` to a JSON argv array for a trusted local detector executable. No command, URL or file path is accepted from an HTTP request. The adapter receives one JSON object on stdin:

    {"imageBase64":"original authorized image bytes","modelVersion":"pinned-artifact-version"}

It returns one JSON object on stdout:

    {"modelVersion":"same-pinned-artifact-version","detections":[{"productCode":"catalog-code","confidence":0.95,"box":[0.1,0.2,0.3,0.8]}]}

Boxes are normalized x1/y1/x2/y2. Output is bounded to 256 KB, 500 detections and 20 seconds. Wrong model versions, malformed output, missing bytes and adapter failure never produce a zero-facing claim. Original field-photo access, visit authorization, checksum and retained consent are rechecked.

Dataset annotations may include `expectedFacings` (product code to integer) and `expectedSlots` (productCode/box objects). The workflow derives visible facing counts, count-based share of shelf, facing-target compliance and configured slot-position matching. Omitted targets remain unknown. All predictions require review; results do not overwrite canonical retail observations.

The automated adapter test exercises a clearly labelled protocol fixture, not a real shelf detector. Representative Sunpride images, detector weights and accuracy approval remain external acceptance inputs. Sample ordering backtests similarly prove workflow and arithmetic, not production forecast quality.
