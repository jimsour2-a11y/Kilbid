# DOLD TechControl v0.5.4 — Stage 12 checkpoint

## DONE

- Full supplied-workbook regression completed: **23/23 PASS**.
- Added the final auto-restore, last/new file choice, freshness, area-follow, priority-label, handoff, older-package, and repair-return assertions.
- Confirmed package `ee.dold.techcontrol`, version code 54, version name 0.5.4, manifest permissions, FileProvider XML, JavaScript syntax, and workflow artifact labels.
- Updated README, changelog, test report, and two-phone instructions.
- Created the v0.5.4 source archive and historical workflow-compatible archive; both have the same SHA-256 and passed ZIP integrity verification.

## VERIFIED

- Full Node regression output: **PASS ALL 23** against the supplied 280-cabinet/250-active workbook.
- Unknown sheets and all original XLSX ZIP entries are preserved by the tested editor path; current cycle and repaired Puudused survive the simulated package round trip.
- Source archives are structurally valid and contain identical project contents.
- No Git repository exists in this working copy; this checkpoint records the saved stage state.

## REMAINS

- No APK was built here: Gradle, Android SDK, adb, and an Android device/emulator are unavailable.
- Android 16 v0.5.4 launch, system-bar appearance, native share chooser, signing compatibility, and the physical two-phone field test remain unverified.
- QR-based phone handoff remains incomplete; use Android Share targets for `.dtc` transfer.
- Workbook score `0` wording in the historical `Juhend` remains an unresolved separate decision.
