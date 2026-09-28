# DOLD TechControl Android v0.5.5

Offline Android field interface for the existing DOLD XLSX workbook. The imported workbook remains the reporting database. Successful saves persist the internal working XLSX and app state.

## v0.5.5 update

- Adds parallel two-phone synchronization using semantic `.dtcs` packages, separate from full `.dtc` work handoff.
- Initializes a second device from the same database lineage while retaining a unique installation-local device ID.
- Merges controls, defects, repairs, and cabinet status by stable logical IDs and changed fields; row numbers are local workbook lookups only.
- Automatically combines different-field edits; same-field differences require an in-app DOLD choice.
- Makes delta package re-import idempotent and rejects wrong database/epoch or invalid hashes before local modification.
- Makes duplicate current-cycle inspection explicit: view, edit the same record, or confirm a separate historical control.
- Keeps the original v0.5.4 internal-save, multi-day cycle, workbook preservation, QR cabinet scanner, search, repair, timer, minimum 60-second rule, and `.dtc` full-handoff behavior.

Parallel sync currently uses Android Share / Quick Share to exchange `.dtcs` files. QR pairing/local-network transfer is not implemented in this version.

## Package and build

- Android package: `ee.dold.techcontrol`
- `versionCode`: 55
- `versionName`: `0.5.5`
- Java 17, Gradle 8.10.2, compile/target SDK 35
- GitHub Actions artifact: `DOLD-TechControl-v0.5.5-debug.apk`

The source bundle does not include a signing key. Certificate compatibility with an APK currently installed on a phone has not been verified. If Android rejects an update for a signing mismatch, preserve the old app's exported XLSX before uninstalling; keep the package ID unchanged.

## Validation status

The headless controller and workbook regression suite passes **31/31** against the latest supplied workbook fixture (280 registry objects, 250 active). All 23 v0.5.4 regression cases remain present and pass. See `DOLD_TechControl_v0.5.5_test_report.md` and `TWO_PHONE_PARALLEL_SYNC_v0.5.5.md`.

The suite uses a Node VM, XML/form adapter, and durable filesystem bridge. It is not Android/WebView or a physical two-phone test. Android SDK, Gradle, emulator, and adb were unavailable in this workspace; no APK has been built here. GitHub Actions, Android 16 startup/Share, signing compatibility, and the two-phone field guide still require device verification.

The workbook guide's conflicting score semantics remain unresolved and unchanged.
