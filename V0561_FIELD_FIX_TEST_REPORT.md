# DOLD TechControl v0.5.6.1 — Field Fix Test Report

## Field failure diagnosis

The v0.5.6 deferred host exposed `REQUEST_RECEIVED` / `ACK_RECEIVED` until its worker consumed the response. The WebView polls that status, so the same event could be observed again while a response was pending. The worker also reset the response slot after the event was visible, leaving a race in which a just-submitted response could be discarded. The fix queues/consumes the response synchronously under the same lock and initializes the response slot before publishing the next event.

Separately, the deferred QR host flow did not guarantee session-specific cleanup for every JS protocol/error return. If the native session remained non-terminal in `WAITING_ACK`, `activeHost` remained occupied and a new QR start returned `SESSION_ACTIVE`. The host flow now stops its own session in `finally`; it does not stop another active session.

## Regression results

| Suite | Result | How verified |
|---|---:|---|
| Original v0.5.5 regression | **31 / 31 PASS** | Isolated headless suite on current field workbook |
| R1 package routing | **10 / 10 PASS** | Isolated `.dtc` / `.dtcs` manifest-routing suite |
| R2 LAN transport | **23 / 23 PASS** | Native Java loopback transport suite |
| R3 QR/bootstrap | **38 / 38 PASS** | Isolated headless pairing/bootstrap suite |
| R4 semantic bidirectional sync | **46 / 46 PASS** | Isolated two-workspace semantic sync suite |
| R4 native LAN session | **4 / 4 PASS** | Native Java deferred-session suite |
| R5 safety/recovery | **98 / 98 PASS** | Isolated two-workspace failure-injection suite |
| v0.5.6.1 field-fix | **15 / 15 PASS** | 11 JS handshake/session tests + 4 native session tests |

The historical regression tests were retained without deletion or weakening. The new field-fix tests were added under `tests/field-fix/`.

## Targeted field-fix coverage

The 15 new checks cover one-time `REQUEST_RECEIVED` consumption, second exchange `ACK_RECEIVED`, terminal `SYNC_COMMITTED`, lost/mismatched commit acknowledgment reporting, immediate session release and QR restart after an unconfirmed outcome, distinct session/token creation, and preserving a different valid session. Retry idempotency and convergence after a lost final acknowledgment are covered by the separately passing R4/R5 suites.

## Static checks

- Application JS and test JS pass `node --check`.
- Package ID verified as `ee.dold.techcontrol`.
- Gradle version metadata verified as `0.5.6.1` / code `57`.
- Native bridge, JavaScript metadata, HTML title/footer and GitHub artifact name verified as `0.5.6.1`.
- Test XLSX: `DOLD_elektrikilbi_sisekontroll_v1.1_24.09.2026 (6).xlsx`, SHA-256 `3e65fcd07299dd9a71426d136459bf38b6fa9c3cee3b04a271cc44d1173fe25a`; headless import reports 280 populated objects and 250 active cabinets.

## Verification boundary

These are headless JS and host-JVM native transport tests. They do not establish that the APK launches or that QR/LAN works on an Android phone. No APK was built in this environment. Physical retest on the same two Android 16 phones remains required after GitHub Actions builds the updated APK.
