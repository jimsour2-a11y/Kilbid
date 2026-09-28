# DOLD TechControl v0.5.5 — Checkpoint Stage 12

## DONE

- Set Android `applicationId` to the unchanged `ee.dold.techcontrol` and Gradle `versionCode 55` / `versionName 0.5.5`.
- Updated visible app title/version, JS package `sourceAppVersion`, and native `getAppVersion()`.
- Updated GitHub Actions output to `DOLD-TechControl-v0.5.5-debug.apk`.
- Added `CHANGELOG_v0.5.5.md`, final `DOLD_TechControl_v0.5.5_test_report.md`, two-phone guide, sync format spec, and per-stage checkpoint files.
- Prepared `DOLD_TechControl_Android_v0.5.5_project.zip` and the historical compatibility-name `DOLD_TechControl_Android_v0.5.1_project.zip` from the same source tree. The two ZIP files have identical SHA-256 hashes.
- Kept the existing JavaScript asset filename so the current `index.html` reference and tests remain valid.
- Kept the v0.5.4 Android startup implementation unchanged apart from the native version string.

## VERIFIED

- Final full headless regression after version changes — **31/31 PASS**, including all 23 v0.5.4 tests.
- JS syntax checks — PASS.
- Both ZIPs passed `unzip -t`; Gradle package/version fields and workflow artifact name verified from inside the archive.
- Package ID is `ee.dold.techcontrol`; no package ID change.
- QR sync remains explicitly deferred as allowed by the task's native-device fallback.
- No Git repository is present, so there are stage checkpoint files but no commit hash.
- No Gradle executable, Android SDK, emulator, or adb is available. No APK was built or installed; Android 16 runtime, physical two-phone transfer, and APK signing-certificate compatibility remain unverified.

## REMAINS

- Run the GitHub Actions build and install/launch on Android 16.
- Verify whether the debug certificate permits update over the installed app; do not assume signature compatibility.
- Perform the documented two-phone Share/Quick Share field test, including the reverse delta, repeated import, and restart checks.
- Implement and validate QR/local-network transfer in a later update before advertising it.
