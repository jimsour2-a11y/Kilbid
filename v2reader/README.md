# v2reader — A2 TEST CANDIDATE

- Isolated Android library (`com.android.library`) and Java-only reader.
- Does **not** depend on `:app`, `MainActivity`, XLSX, v1 storage, signing, or sync.
- Reads exactly TEST 0.1 `WORK_PACKAGE` fixture; validates central ZIP metadata,
  allowed paths/algorithms, stored sizes/CRC, JSON duplicate keys, hashes, IDs,
  references, `environment=TEST` and expected dataset.
- For CHANGE/ACK returns `UNSUPPORTED_IN_A2`, not an acknowledgement.
- **No SQLite, UI or device integration**. No production ID/data is imported.

Validation must run on GitHub Actions before any A2 VERIFIED claim:
`gradle --no-daemon :v2reader:testDebugUnitTest :v2reader:assembleDebug`.

The Python reference in `tests/v2_package/` remains the transport compatibility
reference. Reader has stricter referential consistency checks for recheck tasks,
which must be included in future cross-language conformance tests.
