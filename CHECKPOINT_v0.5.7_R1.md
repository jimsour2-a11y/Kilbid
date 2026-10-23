# DOLD TechControl foundation — R1 persistent ID hydration

## DONE
- `Kontrollid!AA` is read as the authoritative persistent `KontrollID` when it has the accepted `dtc-kontroll-…` form.
- `Puudused!S` is read as the authoritative persistent `PuudusID`; `Puudused!T` is read as its optional `KontrollID` relationship.
- `ensureSyncState()` now uses a valid workbook ID before the existing deterministic / pending-row fallback. Duplicate workbook IDs and pending-operation ID disagreement fail safely.
- Legacy rows without persistent IDs continue using the previous deterministic semantic fallback.
- `UNRESOLVED` rows without S remain `legacyUnresolved`; loading does not write S/T or infer a link. Rows with an existing S retain that ID even when their link status is `UNRESOLVED`.
- `syncDefectValues()` reads an existing T relationship without adding fields outside the schema-1 whitelist.
- Added an R1 focused hydration regression test. It verifies persisted IDs become the sync entity IDs and that all sheet-cell IDs/statuses remain unchanged on load.

## VERIFIED
- R1 focused test on v0.8.3 prototype: 1/1 PASS.
- R1 focused test on legacy v1.1 workbook with no persistent-ID columns: 1/1 PASS.
- v0.8.3 inventory used: 81 persistent `KontrollID`s, 142 persistent `PuudusID`s, 144 defect rows. Rows 23 and 25 have blank S/T and remain unresolved. Rows 24/26 have IDs but unresolved links; IDs and status text are preserved.
- Full comprehensive headless suite: 128/128 PASS on the legacy v1.1 regression fixture.
- Field fix: JS 11/11, native 4/4 PASS. LAN: 23/23 PASS. R4 native LAN: 4/4 PASS. R4 business: 46/46 PASS. R5 safety: 98/98 PASS.
- `node --check` and `git diff --check` pass.
- XLSX source bytes were read-only and unchanged.

## BLOCKER
- The existing v0.5.6.1 behavior still loses 3 checked cabinets after merging a future-sheet workbook from the v0.8.3 fixture (4 → 1). Persistent IDs are now hydrated; cycle association must be fixed in R3.
- Android SDK, Gradle and adb are unavailable, so no APK build or physical device test was performed.

## NEXT
- R2: assign stable IDs before new inspection/defect writes, write AA/S/T/U/V, and materialize incoming v0.5.6.1 operation IDs without changing schema-1 fields.

## Files changed in R1
- `app/src/main/assets/DOLD_TechControl_v0.5.3.js`
- `tests/headless-regression.cjs`
- `CHECKPOINT_v0.5.7_R1.md`
