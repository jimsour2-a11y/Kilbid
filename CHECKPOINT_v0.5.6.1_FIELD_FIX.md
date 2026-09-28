# DOLD TechControl v0.5.6.1 — Final Field-Fix Checkpoint

## DONE
- Fixed the deferred QR/LAN host handshake race and session cleanup failure from v0.5.6.
- Kept the existing semantic sync engine, operation journal, conflict handling, idempotency, XLSX handling, durable workspace and `.dtc` / `.dtcs` fallback intact.
- Updated version to `0.5.6.1`, versionCode `57`; package remains `ee.dold.techcontrol`.
- Updated GitHub Actions artifact to `DOLD-TechControl-v0.5.6.1-debug.apk`.
- Created the complete project archive: `DOLD_TechControl_Android_v0.5.6.1_project.zip`.

## VERIFIED
- Root cause: WebView polling could see the same `REQUEST_RECEIVED` / `ACK_RECEIVED` event again because native state was not consumed synchronously. The host worker also published that event before resetting its response slot under lock, permitting a submitted response to be erased. A JS error return could leave that host non-terminal in `WAITING_ACK`, so a subsequent QR start returned `SESSION_ACTIVE`.
- Native response handling now transitions synchronously to `RESPONSE_QUEUED`; response-slot setup precedes event publication.
- The deferred host flow now stops only its own session in `finally`, including error and cancel paths. It preserves any different valid active session.
- Original v0.5.5 regression: **31/31 PASS**.
- R1 package routing: **10/10 PASS**.
- R2 LAN transport: **23/23 PASS**.
- R3 QR/bootstrap: **38/38 PASS**.
- R4 semantic bidirectional sync: **46/46 PASS**.
- R4 native LAN session: **4/4 PASS**.
- R5 safety/recovery: **98/98 PASS**.
- v0.5.6.1 field-fix tests: **11/11 JS + 4/4 native = 15/15 PASS**.
- After version update, the 15 field-fix tests and static package/version/workflow checks passed again; JS syntax checks passed.
- Project ZIP CRC, required-file list, metadata checks and fresh extracted-tree comparison passed; all **73 files** match the working project tree.
- Project ZIP SHA-256: `06904b4566125697fc2363078f6c438537851b724c02918a3ceba0f7524588f2`.

## BLOCKER
- No headless/native test blocker remains.
- The APK and physical-device behavior are not yet verified. This environment has no Android SDK, Gradle executable, or `adb`; an APK was not built here.
- APK signing-certificate compatibility with the installed v0.5.6 APK was not checked.

## NEXT
- Build the APK through GitHub Actions from this project ZIP.
- Install/test on the same two Android 16 phones. Confirm a completed direct sync reaches `SÜNKROONITUD`, then verify `NÄITA QR` starts immediately after both a successful sync and an intentionally unconfirmed/failing sync.
- Do not begin v0.5.7 until the physical retest is complete.

## Changed files

- `app/src/main/java/ee/dold/techcontrol/LanSyncTransport.java`
- `app/src/main/java/ee/dold/techcontrol/MainActivity.java`
- `app/src/main/assets/DOLD_TechControl_v0.5.3.js`
- `app/build.gradle`
- `app/src/main/assets/index.html`
- `.github/workflows/build-apk.yml`
- `tests/field-fix/field-fix-handshake.test.cjs`
- `tests/field-fix/LanSyncFieldFixTest.java`
- `tests/run-v0561-field-fix-tests.sh`
- `CHANGELOG_v0.5.6.1.md`
- `V0561_FIELD_FIX_TEST_REPORT.md`
- `DOLD_TechControl_v0.5.6.1_limitations.md`
