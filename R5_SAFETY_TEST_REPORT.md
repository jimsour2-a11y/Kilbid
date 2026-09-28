# DOLD TechControl v0.5.6 Recovery — R5 Safety Test Report

## Results

| Regression group | Result | Method |
|---|---:|---|
| Original v0.5.5 | **31 / 31 PASS** | Headless regression against the supplied current workbook |
| R1 package routing | **10 / 10 PASS** | Manifest-based `.dtc` / `.dtcs` routing and preservation cases |
| R2 LAN transport | **23 / 23 PASS** | Native Java loopback transport tests |
| R3 pairing/bootstrap | **38 / 38 PASS** | Headless UI/controller and baseline-transfer tests |
| R4 semantic synchronization | **46 / 46 PASS** | Two independent workspace stores, one-session bidirectional merge |
| R4 native deferred session | **4 / 4 PASS** | Native Java loopback session tests |
| R5 failure/recovery | **98 / 98 PASS** | Two independent workspace stores with injected transport and save faults |
| JavaScript syntax | **PASS** | `node --check` for application controller and headless harness |

These totals are deliberately reported separately; they are not combined into a single number.

## R5 coverage

The 98 R5 assertions verify, among other cases:

- failure before exchange, loss of the first response, failure during the second exchange, and cancellation before durable apply;
- client and host workspace-save failures roll back the receiving side and do not report success;
- a lost final acknowledgement is shown as unconfirmed, while both already committed stores survive restart and safely converge on retry;
- retries and repeated delivery keep Kontroll, Puudus, journal, and applied-operation identities unique;
- wrong database lineage/epoch, corrupt ZIP/hash, unknown action/field, malformed stable IDs, and mismatched operation IDs are rejected before mutation;
- the same cycle remains, checked cabinets are the unique union, repair details survive, and repair does not append a Kontroll row;
- formulas, workbook sheet names/archive parts, durable workspace snapshots, `.dtc` handoff, `.dtcs` sync, and R3 baseline import remain present.

## Test-fixture corrections

No behavioral assertions were deleted or relaxed. The original v0.5.5 field-merge test used synthetic `device-repair` and `device-owner` identifiers that do not satisfy the established installation device-ID format; those test-only IDs now use valid 32-hex suffixes, with the same merge and conflict assertions. The R4 semantic-only two-device fixture now pins its device-local random presence counter because the separate original presence test covers that behavior and random gating had intermittently stopped this multi-save sync test before its third row assertion. The presence behavior and its dedicated test remain unchanged.

## Limits

- This is automated/headless and loopback evidence, not proof of real Android lifecycle or Wi-Fi behavior.
- No APK was built because Android SDK, Gradle, and adb are unavailable in the environment.
- Physical Android 16 installation, QR camera pairing, app-kill handling, real network interruption, and two-phone R5 workflow remain to be tested.
- Version metadata intentionally remains at the R4 baseline (`0.5.5` / code `55`); final v0.5.6 version update belongs to R6.

