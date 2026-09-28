# DOLD TechControl v0.5.6 — Final test report

## Regression results

| Suite | Result | Verification layer |
|---|---:|---|
| Original v0.5.5 regression | **31 / 31 PASS** | Headless app/XLSX regression |
| R1 package routing | **10 / 10 PASS** | Headless content-based `.dtc` / `.dtcs` routing |
| R2 LAN transport | **23 / 23 PASS** | Native Java loopback transport tests |
| R3 QR/bootstrap | **38 / 38 PASS** | Headless pairing, UI and baseline flow |
| R4 semantic sync | **46 / 46 PASS** | Headless two-device bidirectional merge |
| R4 native LAN session | **4 / 4 PASS** | Native Java deferred-session tests |
| R5 safety/recovery | **98 / 98 PASS** | Headless failure injection and retry tests |

The suites were run separately. They are not combined into one total.

## Static and packaging checks

- Package ID verified as `ee.dold.techcontrol`.
- `versionName` / `versionCode` verified as `0.5.6` / `56` in Gradle; the HTML title/header/footer, JavaScript package metadata and native app-version bridge agree.
- Existing workflow `.github/workflows/build-apk.yml` uses Java 17, Gradle 8.10.2 and `:app:assembleDebug`. It now uploads artifact `DOLD-TechControl-v0.5.6-debug` with file `DOLD-TechControl-v0.5.6-debug.apk`.
- Application JavaScript and headless test harness pass `node --check`.
- Referenced application assets, Android source, tests and workflow are present in the final project archive.
- Final project ZIP passed CRC validation, extraction, package/version checks and extracted-tree comparison against the release working tree. It contains no nested project ZIP, unrelated APK, signing key or credentials.

## Test input

The headless XLSX suites used `DOLD_elektrikilbi_sisekontroll_v1.1_24.09.2026 (6).xlsx`, SHA-256 `3e65fcd07299dd9a71426d136459bf38b6fa9c3cee3b04a271cc44d1173fe25a`. The workbook has the expected eight sheets and 400 registry IDs including reserved rows; the regression reports 280 populated objects and 250 active cabinets. The workbook was read-only test input.

## NOT PHYSICALLY VERIFIED

No APK was built in this environment. The Android 16 launch, runtime permissions, camera QR scanning, local Wi-Fi reachability, bootstrap and real two-phone bidirectional sync remain physical acceptance tests. APK signing-certificate compatibility with an installed build was not checked, so update-over-install is not promised.

