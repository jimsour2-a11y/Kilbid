# DOLD TechControl v0.5.5 — Test report

## Current automated result

- Full headless regression: **31/31 PASS**.
- The complete v0.5.4 regression baseline is still present: **23/23 PASS**.
- New parallel-sync and repeated-inspection coverage: 8 tests.
- Final run after setting app/build/native/UI version metadata to `0.5.5` / `55`: **31/31 PASS**.
- Input workbook fixture: latest supplied `Elektrikilpide_sisekontroll_FINAL.xlsx` copy; 280 registered objects, 250 active inspection objects.
- Detailed machine-readable result: `/tmp/dtc-v055-stage12-full/results.json` (temporary local test output; not part of the distributable package).

## Coverage

| Area | Verification |
|---|---|
| Baseline initialization | Same dbId/epoch and deterministic entity IDs; distinct per-installation device IDs |
| Local change journal | Atomic operation creation and save/repair semantic IDs |
| Audit plus repair | Two separate device stores merge inspection, defect, and repair operations without replacing workbooks |
| Two inspections | Phone A and Phone B inspect different EKs; both end with the union and correct checked count |
| Repeated delivery | Reimported package creates no duplicate operation or row |
| Different fields | Owner change and repair closure on one Puudus both survive on both devices |
| Same-field conflict | DOLD choices write the selected value to the same PuudusID; resolution delta converges on the peer |
| Transaction failure | Injected internal-save failure rolls back the received operation; retry succeeds |
| Current cycle / duplicate EK | Incoming inspection updates the checked union; view/edit/new UI preserves one checked cabinet |
| Database safety | Wrong dbId, wrong epoch, and damaged operations hash rejected without mutating local state |
| Restart | Both merged workspaces retain their combined repair and owner state after recreating the app store |
| v0.5.4 regression | Search, QR/presence, timer, XLSX, `.dtc` handoff, repairs, formulas/history, unknown sheets, and other original cases pass |

Static source check: package ID is `ee.dold.techcontrol`; Gradle version is `versionCode 55`, `versionName 0.5.5`; GitHub Actions artifact target is `DOLD-TechControl-v0.5.5-debug.apk`.

## Test limits

The controller suite runs the application JavaScript and workbook editor in a Node VM with an XML/form adapter and a durable filesystem bridge. It is not an Android WebView/emulator test and not two physical Android phones. Android SDK, Gradle, adb, and a device were unavailable, so no APK was built or installed here. Quick Share / Android file picker behavior and Android signature compatibility remain unverified. QR sync is not implemented in this build.

## Required real-phone check

Use the instructions in [TWO_PHONE_PARALLEL_SYNC_v0.5.5.md](TWO_PHONE_PARALLEL_SYNC_v0.5.5.md). Keep a copy of the working XLSX before testing and verify both directions, repeated delivery, and restart persistence on the actual phones.
