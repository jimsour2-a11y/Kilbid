# DOLD TechControl v0.5.4 — Stage 9 checkpoint

## DONE

- Added a transferable `.dtc` package containing the current XLSX, the original base workbook, and the durable cycle/inspection/QR-challenge metadata.
- The sender uses Android's share sheet; the receiver accepts `.dtc` from the file picker.
- The receiver validates ZIP CRCs, entry sizes, SHA-256 digests, workbook/state database identity, checked IDs, and summary totals before offering replacement.
- Existing phone work remains unchanged on cancel. A return package with later repair work is recognized as newer; an older package is identified as older and cannot silently downgrade the saved work.
- Added a two-phone headless handoff/return test using isolated persistent stores. It verifies XLSX share, package contents, inspection cycle restoration, repair-row closure, cancellation, freshness comparison, and corrupt-package rejection.

## VERIFIED

- Focused regression: **1/1 PASS** — `Stage 8/9 XLSX share and complete two-phone work-package handoff/return`.
- The test imports the supplied latest workbook fixture and checks the actual current open-defect counts on both sides against the package summary.
- Work package carries `workbook.xlsx`, `base-workbook.xlsx`, `state.json`, and `manifest.json`.

## REMAINS

- Android's installed share-target chooser and Quick Share/Bluetooth transport still require real-device verification. This workspace has no Android SDK, Gradle installation, emulator, or attached phone.
- Stage 10 QR transfer shortcut is not implemented. A QR cannot safely carry a full workbook and active inspection state; a QR-only shortcut would be misleading without a verified file/connection transport. Use Android's share sheet for the actual transfer.
- Continue Stages 11–12: phone-to-phone guide, complete regression, packaging, and final report.

## Checkpoint record

- No Git repository is present in this working project, so this file is the saved checkpoint record for Stage 9.
