# DOLD TechControl v0.5.5 — Stage 3 checkpoint

## DONE

- Added field-level incoming-operation planning. A field applies automatically only when its current field version matches the operation's base field version.
- A field already equal to the incoming value is treated as resolved/idempotent.
- Concurrent edits to the same field create a persistent conflict containing local value, remote value, field versions, object/defect context, and source operation ID. Conflicting values are not silently overwritten.
- Added explicit DOLD conflict-dialog content with `JÄTA SELLE TELEFONI VÄÄRTUS` and `KASUTA TEISE TELEFONI VÄÄRTUST` choices.
- Added operation commit bookkeeping for applied fields, received operations, applied-op IDs, and unresolved conflicts. The applying workbook transaction is integrated in Stage 4.
- New app-created rows receive installation-unique stable IDs so two phones can independently add similar records without an ID collision. The deterministic migration rule remains for pre-existing v0.5.4 rows.

## VERIFIED

- Focused merge test verified: different-field changes union; same-field conflicting values remain local and create a conflict; repeated op planning is idempotent; the DOLD conflict dialog exposes both choices.
- Existing 23 v0.5.4 tests plus three v0.5.5 tests: **26/26 PASS**.

## REMAINS

- Stage 4: apply merged fields and new entities semantically to workbook sheets, update same logical rows by stable ID, preserve the current cycle, and retain XLSX package parts.
- Later stages: sync package transport/UI, conflict resolution writing, duplicate-inspection UX, QR transport, release metadata/artifacts, and physical-device tests.
- The Android SDK, `adb`, and Git metadata are unavailable in this workspace.
