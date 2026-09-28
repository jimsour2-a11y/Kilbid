# DOLD TechControl v0.5.4 — Stage 1 checkpoint

## DONE

- Startup now scans durable internal workspaces and restores the newest valid full XLSX snapshot into the existing app state.
- The Data page offers `JÄTKA VIIMASE TÖÖFAILIGA` and `VALI UUS XLSX`; startup no longer forces the file picker when an internal workbook is available.
- The saved snapshot carries a SHA-256 hash and a comparison summary. The XLSX remains stored with the current cycle and app-side state.
- Before using another XLSX for a matching cabinet database, the app displays phone and selected-file counts, last inspection, cycle progress, and saved modification metadata. It requires an explicit choice to continue locally, safely merge, or use the selected file.
- Damaged workspace records are isolated so one bad file does not prevent other workspaces from being listed. Invalid XLSX data prompts the user before the selected workbook is opened.
- The v0.5.3 Android startup path and `ee.dold.techcontrol` package were not changed.

## VERIFIED

- Current supplied workbook fixture opened with 280 cabinets and 250 active cabinets; reserved blank IDs remained hidden.
- Existing headless regression suite: **13/13 PASS**, including save durability, process restart, multi-day control, same-row editing, defect de-duplication, 60-second minimum, QR proof, area stats/search, repair persistence, timestamp export, workbook integrity, unknown-sheet preservation, and explicit new-cycle confirmation.
- JavaScript syntax checks passed for the controller and inline app code.
- No Git repository is present in the supplied project directory; this checkpoint records the saved working state.

## REMAINS

- Add direct assertions for automatic startup restore and freshness-choice branches in the final v0.5.4 test stage.
- Verify storage/UI behavior on Android 16 after the complete build; no Android SDK, Gradle, emulator, or attached device is available in this workspace.
- Continue with Stages 2–12 from the field-fix brief.
