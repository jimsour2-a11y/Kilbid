# S2 Kontroll signature test report

## Fixtures

- Full application regression baseline: `DOLD_elektrikilbi_sisekontroll_v1.1_24.09.2026 (6).xlsx`.
- S1.5/S2 production-signature fixture: `DOLD_TechControl_allkirjad_prototuup_v0.9.0_R4_checkpoint(2).xlsx` (SHA-256 `dc4cdb2beefb4502c9a75441d4042160e8619c33959a932b37daa433f45c4e57`).
- OOXML preservation fixture: `DOLD_TechControl_allkirjad_prototuup_v0.8.3(3).xlsx`.
- Legacy cycle fixture: `DOLD_elektrikilbi_sisekontroll_v1.1_24.09.2026 (6).xlsx`.

## Results

- Full headless regression: **160/160 PASS**.
- S2 signature targeted suite: **7/7 PASS**.
- S1 native core: **30/30 PASS**.
- S1 UI/source contract: **19/19 PASS**.
- S1 signature launch/read-only view: **2/2 PASS**.
- S1.5 capture/navigation/version tests: **4/4 PASS**.
- R4 score-scale tests: **10/10 PASS**.
- R4 business sync: **46/46 PASS**.
- R5 sync safety: **98/98 PASS**.
- R5 OOXML preservation: **31/31 PASS**.
- JavaScript syntax checks and `git diff --check`: **PASS**.

S2 tests cover acceptance into existing R4 sheets/Rich Data, repeated-commit idempotency, exact-capture anti-reuse rejection, durable-save rollback, unsupported workbook structure, stale record-version rejection, signed-record edit/revocation, a distinct re-sign capture, prior-proof preservation, and restart restoration of the workbook pointer/effective status.

## Not verified here

- No Android APK or physical-device test was run. Android SDK/Gradle are unavailable in this environment.
- The test runner validates OOXML parts and hashes but cannot prove that Microsoft Excel for Android renders the new Picture-in-Cell display identically to the prototype. Verify the GitHub Actions APK on CAT S42 and open the exported workbook in current Microsoft Excel before production use.
