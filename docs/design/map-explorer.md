# SP-0254 — Philippine areas explorer

## Reference study (before implementation)

Studied the public preview in Ubuntu Chrome on CDP 9333, including its live frame, metric switch, legend toggle, ranked California row → counties, list focus, and Escape → national view. Also inspected jc's two recording contact sheets. No paid code, installer, source bundles or purchase was used.

The preview is a quiet white card on a pale neutral stage, with a thin border, 12px corners, 20–24px internal padding at normal scale. A 14px medium-weight title and 12px muted period sit left; compact 32–40px segmented metric controls sit right. The area label is small and muted above a 28px tabular headline; its explanatory label sits on the same baseline. Geometry dominates, with no road tiles, axes or labels competing with the fills. White 0.7–1px internal boundaries separate five discrete pale-to-deep blue steps. No-data is neutral, not the lowest numeric bucket.

At a container width of 820px the ranked list sits right, about 290px wide; below that it stacks beneath the map. Rows are 44px tall with a small muted rank, area name, right-aligned tabular value and understated bar. Only the list scrolls when map hover brings a low-ranked area into view. Hover outlines the shape dark without altering its fill; a white shadowed 220px tooltip with 10px radius shows name and ordinal rank, all metrics in label/value rows, selected metric darker, then “Select to zoom in”. The legend is a short five-step horizontal ramp; pointer hover dims nonmatching areas and clicking pins that range. Escape releases the pin before going up a level. In the public preview California opens 58 counties, retaining the parent as context; Escape returns to all states. The recording shows the same compact tooltip and blue/amber palette during a Growth switch.

Motion observed and documented in the public reference: west-to-east fill delays complete within 800ms; camera translate/scale glide together while children appear; headline counts to new values, ranks slide vertically and bars resize. Reduced motion makes these changes immediate. This implementation will use independent motion code, not the reference's implementation.

## Sunpride adaptation and owner question

Question: where are customers and sales concentrated, which areas have visits left, and which stores or salesmen should I inspect next?

Keep the existing pin map unchanged behind “Pins”; add “Areas” alongside it in Field → Live map. Use the existing UI colors, type, border and focus tokens. Regions → provinces/NCR districts → cities/municipalities → optional verified store and currently shared salesman pins. Back and Escape traverse the same hierarchy; a roving ranked list offers Arrow/Home/End and native Enter/Space activation. Touch controls are at least 44px. No sideways scrolling at 390px.

Metrics: booked sales (non-draft/non-rejected/non-voided orders, explicitly not collections or invoiced revenue), current customers, completed/planned visits, distinct active salesmen with visit activity in the period, and customers added in the period. Period defaults to month to date in Manila, with Today and Last 7 days options. Use canonical stored customer PSGC, current owner scope and source-order access, not inferred address strings or org-unit names. Preserve unknown amounts, unlocated rows and unmapped boundary coverage explicitly. Empty geography is grey, numeric zero with a measured source remains a numeric zero. Totals/ranking/tooltip derive from the same response. No fake figures in production.

## Open boundaries

Use NAMRIA/PSA boundaries through OCHA COD-AB (CC BY-IGO), packaged by faeldon/philippines-json-maps (MIT tooling), PSGC 2026-3Q. Vendor low-resolution TopoJSON, only regions plus one region's provinces and one province's cities fetched at a time; use d3-geo projection and topojson-client decoding. Pin upstream revision in the generated manifest, retain attribution and license. PSGC is an identifier string padded to ten digits; never infer membership from names. Source geometry is illustrative, not a legal/survey map. Report any source/code mismatch, not a made-up boundary.

## Geometry and picker reconciliation

The source has 18 regions, 88 province/district shapes (including the Special Geographic Area), and 1,642 municipality/city shapes. The customer picker's 1,655 city-level entries include Manila's 14 sub-municipalities rather than one Manila city. The vendor script replaces that one outline with the publisher's actual 14 SubMun polygons, and asserts exact city-code set equality against our committed PSGC reference. No municipality is silently left without a shape.

NCR district and Isabela pseudo-province codes differ between the picker and the map publisher. An explicit reviewed code crosswalk handles parent-only addresses. For recognized city PSGCs the generated polygon-parent index is authoritative for display, including the eight SGA municipalities (which the picker groups under Maguindanao del Sur). This does not edit customer records or change business-unit authorization. The API ships its generated index independently of web static assets. All 107 geometry files total 759,952 uncompressed bytes; the browser loads only one level at a time.

## Acceptance proof

Unit tests cover equal/empty/zero/unknown color steps, deterministic ties, ordinal ranks, keyboard bounds and Escape precedence. API proof covers scoped customer/visit/sales aggregation and foreign source orders; admin screenshots must come from the running lane website and real lane reads, not mocked browser responses. Screenshots identify sample lane contents as sample where applicable. Production deployment and phone work are outside this lane.
