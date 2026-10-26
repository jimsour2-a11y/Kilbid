# DOLD TechControl v0.5.7 — S3 Parandus signature test report

## Result

S3 implementation and headless verification passed. Android package/version remain `ee.dold.techcontrol` / `0.5.6.1` / code `57`.

Implementation commit: `ef7063d00c1e8e3c621acb84b73705e869b693e5`.

## Required S3 scenarios

- S3 targeted suite: **6/6 PASS**.
- Permanent ParandusID saved before native capture; production signature commits as `TargetType=Parandus`, with matching pointer/status, record snapshot, proof and exact 900×300 PNG: PASS.
- 200 raw touch points round-trip exactly through the production ZIP/XLSX path; Rich Data picture is linked; repeated commit is idempotent: PASS.
- Cancel leaves repair saved unsigned, creates no signature, and the saved repair can be signed later: PASS.
- Unresolved legacy target and unsupported Parandused contract fail closed: PASS.
- Exact local signature reuse across Kontroll and Parandus is rejected: PASS.
- Protected repair-field mutation during capture blocks commit: PASS.
- S3 preservation assertion checks existing R4 cells/formulas and unrelated OOXML package parts while permitting only the expected signature/repair changes and app workspace metadata: PASS.

## Regression results

| Suite | Result |
|---|---:|
| Full headless regression, with legacy v1.1 and separate R4 signature fixtures | **177/177 PASS** |
| S1 native signature core | **38/38 PASS** |
| S1 / S1.5 source and UI contract | **26/26 PASS** |
| S2 signature production suite | **18/18 PASS** |
| S3 Parandus targeted suite | **6/6 PASS** |
| R1 package routing | **10/10 PASS** |
| R1 permanent ID hydration | **1/1 PASS** |
| R2 persistent-ID targeted tests | **2/2 PASS** |
| R2 LAN transport | **23/23 PASS** |
| R3 cycle reconciliation | **7/7 PASS** |
| R3 QR/bootstrap | **38/38 PASS** |
| R4 scoring | **10/10 PASS** |
| R4 semantic business sync | **46/46 PASS** |
| R4 native LAN | **4/4 PASS** |
| R5 safety | **98/98 PASS** |
| R5 v0.8.3 OOXML preservation | **31/31 PASS** |
| JavaScript syntax checks | **PASS** |
| `git diff --check` | **PASS** |

The subgroup totals overlap with the 177-test integrated run and should not be added together.

## Physical/build status

The environment has no Android SDK, Gradle executable or ADB. APK build was **not attempted**; no physical S3 Android test is claimed. The next verification is a GitHub Actions debug build followed by the requested OnePlus 13 repair-signature flow and Excel Desktop inspection.

Physical follow-up: on OnePlus 13, close a test defect through `Paranduse lõpetamine`, confirm, verify `ALLKIRI` targets `Parandus • EK-006` and shows the permanent ParandusID/version, capture and confirm, export, then inspect the Parandused pointer/status, raw strokes, picture/proof and `Kontrollakt Auto` in Excel Desktop. Repeat once with `TAGASI` and confirm the repair remains unsigned and can be signed later.

## Scope and limitations

- No XLSX file or XLSX contract was modified. The supplied R4 workbook itself confirmed the approved `Parandused` columns, status formula and `Kontrollakt Auto` linkage; the separately named contract Markdown file was not present in the supplied workspace.
- No signature data was added to LAN or semantic sync. The current local-only signature behavior remains in effect.
- Existing direct-baseline `PAYLOAD_TOO_LARGE` observation was not changed.
- No S3 physical acceptance, APK installability or signing compatibility is asserted.
- The local source repository is shallow at `6498760a0d0d3d9d234d0916434408b6a63ce473`; the transfer bundle declares that existing commit as a prerequisite and must be imported into the authenticated clone with that base history.
