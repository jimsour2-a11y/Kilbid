# DOLD TechControl v0.5.5 — Stage 4 checkpoint

## DONE

- Added semantic workbook application for incoming `Kontroll`, `Puudus`, and cabinet status operations. Row numbers are used only as temporary local XLSX write locations; operation identity and cross-device lookup use stable logical IDs.
- New inspections append the appropriate `Kontrollid` row with cabinet fields, H:R scores, W/X time values, numeric Y duration, Z exception, and the existing workbook's formula/report structure left intact.
- Inspection updates locate the same logical `KontrollID` row. Defect updates/closures locate the same `PuudusID` row. Repairs update Puudused only.
- New defects are appended to Puudused with existing business fields. Cabinet status updates resolve the cabinet by permanent EK ID and update Kokkuvõte status.
- Current-cycle progress is unioned only when the incoming operation names the matching cycle ID. The receiving phone preserves its own cycle entries.
- Incoming operations apply inside one atomic transaction. Non-user-resolvable failures restore the previous workbook and sync state. Received operations do not get re-journaled as new local edits.
- Added the two-phone audit-vs-repair test, including repeated operation delivery and progress restoration.

## VERIFIED

- Focused two-phone semantic-apply test passed. Both local change sets survived the exchange. The incoming inspection and defect appeared on Phone B; the Phone B repair appeared on Phone A; repeating the same operation did not duplicate it.
- Existing v0.5.4 behavior and v0.5.5 model/journal/conflict tests passed.
- Combined regression suite: **27/27 PASS** against the current 280-cabinet/250-active workbook fixture.
- JavaScript syntax checks passed.

## REMAINS

- Stage 5: parallel sync baseline/delta package, SHA-256 manifest, and Android Share import/export while preserving `.dtc` handoff separately.
- Later stages: conflict resolution write-back, duplicate-inspection warning/view/edit/new flows, QR local transport, final version/artifacts, and physical-phone tests.
- Real Android build/device verification remains unavailable in this workspace (no Android SDK, Gradle, or adb).
