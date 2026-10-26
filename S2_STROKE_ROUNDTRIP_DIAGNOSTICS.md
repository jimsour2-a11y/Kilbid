# S2 stroke round-trip diagnosis

## Root cause and fix

The OnePlus 13 diagnostic showed 243 expected points, 243 DOM rows, and 243 `AllkiriID` occurrences in serialized XML. Rows 5–247 were present after reparse, but zero IDs were read from the A cells. This isolated the failure to reading inline string text after `XMLSerializer → DOMParser`; the point rows themselves were not lost.

`getInline()` used `getElementsByTagName("t")`, which only matches the literal qualified name. In the failing namespace-qualified SpreadsheetML representation, the text nodes were named `x:t`. The existing namespace-safe `qsa(cell,"t")` matches by local name and namespace. `getInline()` now uses that helper. No writer, renderer, hashes, verification, or XLSX contract code changed. Diagnostic fail-closed verification remains enabled.

The failure is checked in `s2VerifyProductionCandidate()` after `s2AppendStrokeRows()` has appended the rows, `xmlStr()` has serialized the worksheet, and the serialized text has been placed into the candidate JSZip object. That verification runs before the candidate is generated as final ZIP bytes. The next useful physical evidence is therefore the new count/range detail in the error, which separates append, serialization, and reparse stages.

If a mismatch remains, the diagnostic error reports:

- expected point count;
- matching DOM row count and first/last DOM row;
- occurrences of the exact `AllkiriID` text in serialized XML;
- matching rows after the candidate XML is reparsed;
- first expected `PunktNr` that no longer matches and last one that matched;
- matching-ID row range, used-row range, and worksheet dimension.

The targeted XML regression first demonstrates that the old lookup returns no text for prefixed `<x:t>` elements, then verifies that `qsa()` and the fixed `getInline()` return both rich-text runs in order. It also verifies ordinary unprefixed `<t>`.

## Reproduction coverage

New full-path tests exercise the production commit and then generate, reopen, and parse the resulting XLSX ZIP:

- 224 points across 2 strokes;
- 243 points in 1 stroke (the physical reproduction);
- 317 points in 1 stroke;
- 360 points across multiple strokes;
- 640 points across multiple strokes.

Every test verifies all six row values (`AllkiriID`, `StrokeNr`, `PunktNr`, `X_norm`, `Y_norm`, `ElapsedMs`) and order. The native canvas is 640×760 while the production PNG is the existing canonical v2 PNG. All five cases pass in the available headless XML implementation.

A fault-injection test removes a row from the candidate and confirms that verification still rejects it, the active workbook is unchanged, and the local draft remains available. This validates the diagnostics and fail-closed behavior; it does not reproduce the OnePlus failure.

## Test results

- Full configured headless regression: 153/153 PASS.
- S2 signature suite: 18/18 PASS, including the five production ZIP round-trips and namespace-qualified inline string regression.
- S1 native signature core: 38/38 PASS.
- S1 UI/source contract: 20/20 PASS.
- R4 semantic sync: 46/46 PASS.
- R5 safety group: 98/98 PASS.
- JavaScript syntax and `git diff --check`: PASS.
- R5 OOXML preservation: 31/31 PASS on the supplied v0.8.3 prototype fixture.

The code fix is verified in the test DOM and full XLSX production path. A new APK still needs to be installed and tested on the OnePlus 13 to confirm that the physical signature commit now passes the Android WebView reparse stage.
