# DOLD TechControl v0.5.4 — verification report

## Scope and input

- Source: saved v0.5.3 startup-fix project in `techcontrol_v053`; no fresh project was created.
- Workbook fixture: `DOLD_elektrikilbi_sisekontroll_v1.1_24.09.2026 (6).xlsx`.
- Fixture import reads **280 registry cabinets** and **250 active cabinets** dynamically; no cabinet count is hardcoded.
- Package configuration: `ee.dold.techcontrol`, `versionCode 54`, `versionName 0.5.4`.

## Regression result

**23/23 PASS** using `tests/headless-regression.cjs` against the supplied workbook. Covered:

- import counts and reserved blank IDs;
- multi-day cycle start time and no fabricated midnight;
- hard 60-second minimum and migration from below 60;
- durable save, process restart, last-file restoration, and new-file choice;
- checked/unchecked filters, same-row editing, and defect de-duplication;
- disk write failure rollback;
- random QR challenge, wrong code rejection, and matching camera proof;
- area statistics and automatic area context on cabinet open;
- current live search and no stale result list;
- repair-mode save without creating a fake Kontrollid row;
- timestamped XLSX export with internal cycle restoration;
- original workbook ZIP parts, formulas/other sheets, unknown future sheet, and numeric duration;
- freshness decisions for internal newer, incoming newer, and ambiguous cases;
- A/B/C/D descriptions;
- phone A → phone B → repair → restart → phone A package round trip;
- older package warning/cancellation and corrupt-package rejection.

The test harness runs the app's actual JavaScript workbook logic under Node with an XML adapter and an fsync-backed storage bridge. It is not an Android or WebView runtime test. The two-phone test simulates two independent internal stores and validates package integrity and workbook state.

## Static build-input checks

- Android manifest keeps the existing camera permission and declares the FileProvider for share output.
- `MainActivity` retains the v0.5.2-style startup path; the previously implicated WindowInsets listener is absent.
- The referenced bundled controller exists at `app/src/main/assets/DOLD_TechControl_v0.5.3.js` and remains loaded by `index.html`.
- GitHub workflow artifact names are updated to v0.5.4.

## Not verified here

- Android/Gradle compilation and APK assembly: unavailable because this workspace has no Gradle installation or Android SDK.
- Android 16 v0.5.4 launch, status-bar appearance, native FileProvider chooser, Quick Share/Bluetooth, and the field guide on two physical phones.
- APK signing-certificate compatibility with the installed v0.5.3 debug APK. The signing key is not included; if Android requires uninstall, export the old app's timestamped XLSX first.
- QR-based phone handoff. The existing cabinet QR scanner remains in place; work-package transfer uses Android Share.

## Outstanding workbook issue

Scoring semantics were not changed. The current app treats `0` as `Ei ole / puudub` and excludes it from the mean, while older `Juhend` text had a contradictory meaning. Resolve that separately with the workbook owner before changing score interpretation.
