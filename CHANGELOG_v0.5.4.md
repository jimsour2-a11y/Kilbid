# DOLD TechControl v0.5.4

## Field workflow

- Restores the last valid internal XLSX and current multi-day Kontroll after process restart.
- Offers an explicit choice to continue the internal file or select another XLSX; compares counts, progress, latest inspection, and revision metadata before replacement.
- Uses a DOLD confirmation dialog when adopting historical Kontrollid records into the active cycle.
- Saves the cycle's local start time and uses the earliest real `Kontrollid!W` start when reconstructing a cycle.
- Changes Ala/osakond context to the opened cabinet and retains the area progress totals.
- Shows practical priority descriptions for grades A/B/C/D.
- Renames the XLSX page to **Andmed**; retains XLSX export and adds sharing through Android's native share sheet.
- Adds `.dtc` handoff packages with the current XLSX, base workbook, cycle/app state, manifest, and SHA-256 checks. Receiver comparison and explicit acceptance prevent silent replacement; repair updates transfer back to the first phone.
- Updates the workflow artifact name to `DOLD-TechControl-v0.5.4-debug`.

## Preserved

- Package `ee.dold.techcontrol`; `versionCode 54`; `versionName 0.5.4`.
- Proven v0.5.2-style Android startup path. No WindowInsets startup listener was reintroduced.
- Existing camera QR identification, live search, XLSX sheet editing, 60-second minimum, random presence challenge, inspection editing, defect de-duplication, repair mode, unknown-sheet preservation, formulas, and history.
- Score meanings remain as in the current app. The older contradictory workbook `Juhend` wording remains unresolved.

## Limitations

- QR phone-to-phone transport was not added. Use Android Share targets such as Quick Share or Bluetooth.
- `.dtc` is integrity-checked but not encrypted.
- APK build, signature compatibility, Android 16 v0.5.4 launch, real safe-area appearance, share targets, and two-phone field run remain unverified here.
