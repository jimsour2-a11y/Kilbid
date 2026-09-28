# DOLD TechControl v0.5.5

## Parallel work across two phones

- Adds separate `.dtcs` sync baseline and delta packages while preserving `.dtc` as the whole-workbook handoff/replacement flow.
- Uses an installation-local `deviceId`, shared `dbId` and sync epoch, deterministic migration IDs, and semantic operation IDs.
- Adds field-level merges for Kontroll, Puudus, and cabinet status. Different-field edits combine; conflicting same-field edits show a DOLD choice and propagate the selected value.
- Applies received changes to logical records in the existing XLSX, records repairs against the same Puudus row, updates current-cycle progress, and persists each package merge transactionally.
- Adds baseline initialization, Share/Quick Share send/receive actions, change preview, package integrity checks, lineage rejection, and repeated-import idempotency.

## Repeat inspection safety

- Opening a cabinet already inspected in the current cycle prompts **VAATA KONTROLLI**, **MUUDA KONTROLLI**, or **UUS KONTROLL**.
- Read-only view does not start the timer.
- Edit updates the same stable KontrollID.
- A separate new inspection requires a second explicit confirmation and keeps the current-cycle checked count at one.

## Preserved behavior

- Preserves internal XLSX save/restore, multi-day Kontroll, current search and area filters, QR cabinet scan/presence challenge, repairs, 60-second hard minimum, `.dtc` handoff, and workbook formulas/history/unknown sheets.
- Keeps package ID `ee.dold.techcontrol`; sets `versionCode 55` and `versionName 0.5.5`.
- Updates the GitHub Actions artifact name to `DOLD-TechControl-v0.5.5-debug.apk`.

## Known limits

- QR pairing/local-network transport is deferred; use Android Share / Quick Share for `.dtcs` exchange.
- Android build/install, Android 16 runtime, signing-certificate compatibility, and physical two-phone behavior were not verified in this workspace.
- No APK was built here because Android SDK/Gradle are unavailable.
- Existing scoring-semantics discrepancy in workbook guidance remains unresolved and was not changed.
