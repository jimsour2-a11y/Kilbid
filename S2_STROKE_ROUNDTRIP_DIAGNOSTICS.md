# S2 stroke round-trip diagnosis

## Status

The OnePlus 13 production failure `STROKES_INVALID: Kõiki allkirja puutepunkte ei kirjutatud.` is still unresolved. No production write, hash, renderer, capture, or XLSX contract behavior was changed in this checkpoint. The native draft and transaction rollback behavior remain as before.

The failure is checked in `s2VerifyProductionCandidate()` after `s2AppendStrokeRows()` has appended the rows, `xmlStr()` has serialized the worksheet, and the serialized text has been placed into the candidate JSZip object. That verification runs before the candidate is generated as final ZIP bytes. The next useful physical evidence is therefore the new count/range detail in the error, which separates append, serialization, and reparse stages.

The error now reports:

- expected point count;
- matching DOM row count and first/last DOM row;
- occurrences of the exact `AllkiriID` text in serialized XML;
- matching rows after the candidate XML is reparsed;
- first expected `PunktNr` that no longer matches and last one that matched;
- matching-ID row range, used-row range, and worksheet dimension.

## Reproduction coverage

New full-path tests exercise the production commit and then generate, reopen, and parse the resulting XLSX ZIP:

- 224 points across 2 strokes;
- 317 points in 1 stroke;
- 360 points across multiple strokes;
- 640 points across multiple strokes.

Every test verifies all six row values (`AllkiriID`, `StrokeNr`, `PunktNr`, `X_norm`, `Y_norm`, `ElapsedMs`) and order. The native canvas is 640×760 while the production PNG is the existing canonical v2 PNG. All four cases pass in the available headless XML implementation.

A fault-injection test removes a row from the candidate and confirms that verification still rejects it, the active workbook is unchanged, and the local draft remains available. This validates the diagnostics and fail-closed behavior; it does not reproduce the OnePlus failure.

## Test results

- Full configured headless regression: 153/153 PASS.
- S2 signature suite: 16/16 PASS, including the four production ZIP round-trips.
- S1 native signature core: 38/38 PASS.
- S1 UI/source contract: 20/20 PASS.
- R4 semantic sync: 46/46 PASS.
- R5 safety group: 98/98 PASS.
- JavaScript syntax and `git diff --check`: PASS.
- R5 OOXML preservation: 31/31 PASS on the supplied v0.8.3 prototype fixture.

The physical failure still needs a new OnePlus capture/build to obtain its stage counts. The passing XML harness does not establish that the Android WebView runtime is free of this issue.
