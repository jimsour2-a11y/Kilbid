# DOLD TechControl v0.5.4 — Stage 8 checkpoint

## DONE

- Added `JAGA TÖÖFAILI XLSX-I` to Andmed. It shares the current internally saved XLSX under a timestamped name.
- The share action persists current state first but does not reset Kontroll progress or mark the workbook externally exported.
- Added a native Android `ACTION_SEND` chooser using a cache-backed `FileProvider` content URI with read permission. This exposes normal installed share targets such as Quick Share, Bluetooth, OneDrive (if registered), Drive, mail, and messaging apps.
- Kept the existing timestamped XLSX export path intact.
- Updated Gradle to `versionCode 54` / `versionName 0.5.4`; package remains `ee.dold.techcontrol`.

## VERIFIED

- Manifest and FileProvider path XML parse successfully.
- JavaScript syntax checks pass; static inspection confirms `ACTION_SEND`, URI grant, chooser, timestamped XLSX, and share button wiring.
- Existing Android startup and QR scanner paths were not modified.

## REMAINS

- Native compilation and real Android 16 share-target testing remain unverified because this workspace has no Android SDK/Gradle/device. The GitHub Actions build and two-phone test are still required.
- Add transfer package in Stage 9; return/import round-trip test remains for Stage 12.
