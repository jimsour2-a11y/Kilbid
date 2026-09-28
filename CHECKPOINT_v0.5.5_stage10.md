# DOLD TechControl v0.5.5 — Checkpoint Stage 10

## DONE

- Expanded two independent device-store tests using distinct persisted `deviceId` values and one shared `dbId`/epoch.
- Phone A performs audit work while Phone B repairs an existing Puudus and inspects a different EK; exchanging `.dtcs` packages leaves both phones with the union and two checked EKs.
- Repeated package import is idempotent; no additional Kontrollid/Puudused rows are created.
- Added same-Puudus field merge coverage: Phone A changes `owner`, Phone B closes the defect. Both fields and repair details survive on both phones.
- Added valid-package save-failure coverage: failure rolls the received operation back and a retry succeeds.
- Restarted both stores after merge and verified the merged owner/repair state persists.
- Added explicit wrong-epoch rejection alongside existing wrong-dbId and corrupt-hash rejection checks.
- Existing tests continue to cover stable IDs, same-field conflict resolution and convergence, checked-count union, duplicate-inspection UI, `.dtc` handoff separation, unknown workbook parts, formulas, and current-cycle restore.

## VERIFIED

- `node --check` for app controller and test harness — PASS.
- Focused two-phone merge/rollback/restart test — PASS.
- Focused `.dtcs` baseline/delta, distinct inspection, repeated sync, wrong-db, corrupt-package, wrong-epoch test — PASS.
- Full regression suite — **31/31 PASS**.
- The 23 original v0.5.4 tests remain present and pass; 8 additional v0.5.5 tests are present.
- Full result JSON: `/tmp/dtc-v055-stage10-full/results.json`.
- Test input: supplied latest workbook fixture, with 280 registered objects and 250 active cabinets.
- Testing used a Node VM/XML/form adapter, not two physical Android devices.
- No Android SDK/Gradle/ADB or Git repository is available; this file is the persistent checkpoint.

## REMAINS

- Prepare an exact two-phone field guide and sync-format documentation (Stage 11).
- Run final v0.5.4 regression plus all new cases together after version/build metadata changes.
- QR transport remains deferred and must be identified as such in final documentation.
