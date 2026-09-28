# DOLD TechControl v0.5.6 recovery — R3 test report

## Results

| Suite | Result | Scope |
|---|---:|---|
| Original v0.5.5 regression | 31 / 31 PASS | Existing application/workbook behavior |
| R1 package-routing regression | 10 / 10 PASS | `.dtc` / `.dtcs`, renamed ZIP packages, manifest routing, XLSX, handoff and idempotency |
| R2 native LAN transport tests | 23 / 23 PASS | Authenticated temporary socket transport on host JVM |
| R3 QR/bootstrap headless tests | 38 / 38 PASS | Pairing validation, QR routing, DOLD confirmation UI, baseline bootstrap, lineage/device identity, restart and cancellation |

## Verification boundary

The JavaScript suite executes the application controller in a Node VM with a DOM/workspace bridge adapter. It verifies the app's call into the native LAN API, but it is not an Android WebView or physical-device test. R2 transport tests exercise `LanSyncTransport` using host-JVM loopback sockets.

No Android SDK, Gradle executable, `adb`, or configured Android SDK path is available in this environment. An APK was not built. QR rendering, camera scanning, Wi-Fi/LAN reachability, and first-time bootstrap still need testing on two Android phones on the same local network.

## Commands

```sh
DTC_TEST_EXCLUDE='R1 package|R3' node tests/headless-regression.cjs <workbook.xlsx> <results-dir>
DTC_TEST_FILTER='R1 package' node tests/headless-regression.cjs <workbook.xlsx> <results-dir>
sh tests/run-lan-transport-tests.sh
DTC_TEST_FILTER=R3 node tests/headless-regression.cjs <workbook.xlsx> <results-dir>
```
