# DOLD TechControl S2 checkpoint — Kontroll signature acceptance

## Baseline and scope

- Branch: `foundation-v0.5.7`
- Baseline before S2: `4c287846d4fae4317e1b7b0799fa276570d1b4e2`
- Package remains `ee.dold.techcontrol`.
- `versionName` remains `0.5.6.1`; `versionCode` remains `57`.
- No XLSX fixture was modified. No LAN, sync protocol, Parandus signature flow, or release version was changed.
- Implementation commit: `f081b4a0984195b76a50caf7f4656821da4a16f2`.

## DONE

- A native locally saved Kontroll draft can now be read back through a narrow Android bridge with the capture proof, normalized touch points, and PNG bytes.
- DOLD validates the capture against the active workbook’s permanent `KontrollID`, current protected record version, target metadata, exact renderer profile, stroke/geometry/PNG hashes, and local anti-reuse registry.
- Acceptance writes the Kontroll signature into the existing v0.9.0 R4 `Allkirjad`, `Allkirja_jaljed`, and `Allkirjade pildid` structures; appends the display PNG and Picture-in-Cell Rich Data reference; then updates `Kontrollid!AB`.
- All workbook parts are staged in one candidate workbook and committed through the existing durable workspace transaction. Failed validation or persistence leaves the active XLSX unchanged and the native draft available for retry.
- Repeating the same native draft is idempotent.
- Editing a signed Kontroll revokes its prior signature in the same business-data transaction while retaining its original proof and capture evidence. A later new capture points to the prior `AllkiriID` in `O` and becomes the `Kontrollid!AB` target.
- Saved inspection detail now reports the workbook signature state after reopening.
- Added S2 harness, alternate native-rendered capture fixture, restart coverage, rollback coverage, stale-record and unsupported-schema tests.

## VERIFIED

| Check | Result |
|---|---:|
| Full headless regression, v1.1 working workbook baseline with R4 signature fixture | 160/160 PASS |
| S2 signature-specific tests on v0.9.0 R4 workbook | 7/7 PASS |
| R5 OOXML preservation round-trip on v0.8.3 workbook | 31/31 PASS |
| S1 native capture/store core | 30/30 PASS |
| S1 Android/UI source contract | 19/19 PASS |
| S1 saved-inspection signature tests | 2/2 PASS |
| S1.5 signature flow/version tests | 4/4 PASS |
| R4 scoring tests | 10/10 PASS |
| `node --check` for app JavaScript and headless harness | PASS |
| `git diff --check` | PASS |

The v0.9.0 R4 workbook used for signature acceptance has SHA-256:
`dc4cdb2beefb4502c9a75441d4042160e8619c33959a932b37daa433f45c4e57`.

The full headless run reported `R4 BUSINESS 46/46 PASS` and `R5 SAFETY 98/98 PASS` within its 160 passing cases. The separate v0.8.3 archive-preservation run reported `R5 XLSX STRUCTURE 31/31 PASS`.

## REMAINS / limits

- No local Android SDK/Gradle installation is available, so no APK was built here.
- Android runtime behavior and Microsoft Excel opening of newly appended Picture-in-Cell Rich Data still require the GitHub Actions APK and physical-device/Excel field check. Headless OOXML tests do not replace that check.
- Existing signature records in the fixture remain preserved as prototype/test data; this change does not convert them into production signatures.
- Parandus signature acceptance remains out of scope.

## NEXT

Build this development branch through GitHub Actions and verify the test APK on the CAT S42. Check capture, clear/cancel, confirm, restart persistence, active XLSX signature status, and re-sign after editing before considering any later S stage.
