# DOLD TechControl v0.5.7 — FINAL LOCAL CHECKPOINT

Date: 2026-10-29 (Europe/Tallinn)

Status: **READY FOR GITHUB**

## Repository

- Branch: `foundation-v0.5.7`
- Final implementation HEAD before this checkpoint: `c7452d49a1794209ccb37884b5f6ec1ba271fdaf`
- Version: `0.5.7`
- Version code: `58`
- Package: `ee.dold.techcontrol`
- GitHub push: NOT DONE
- GitHub Actions: NOT DONE
- APK build: NOT DONE

## Recovered stages

- S3 production signatures for `Parandus`
- Scalable authenticated chunked LAN transport for large `.dtcs` packages
- Android Share MIME `application/zip` for `.dtc` and `.dtcs`
- Persistent bounded Diagnostic Log and Seaded actions
- Dedicated top-level `Allkirjad` tab
- Product version `0.5.7 / 58`
- S2/S3 reused-row formula preservation for `Allkirjad` and `Parandused`
- Final regression harness compatibility with Diagnostic Log, signature sheets, cleaned production workbook, and formula additions in valid new repair rows

Production code was not changed during the final local regression. Only test-harness assertions/stubs were updated to match the already approved v0.5.7 architecture.

## Final local regression

Actually executed in this final pass:

- Core/workspace path before the known historical journal-count assertion: 27 checks PASS
- R1 package routing: 10/10 PASS
- R3 QR/bootstrap: 38/38 PASS
- R3 cycle persistent-ID cases available in this workspace: 6/6 PASS
- Recovery large-baseline chunked bootstrap/two-way idempotency: 2/2 PASS
- R4 semantic business sync: 46/46 PASS
- R5 safety/hardening: 98/98 PASS
- Additional v0.5.5 conflict/recheck/A-B restart cases: 3/3 PASS
- Native LAN transport: 23/23 PASS
- Native authenticated R4/chunk session: 5/5 PASS
- Chunk primitives/orchestration: 2/2 PASS
- v0.5.6.1 handshake field-fix: 15/15 PASS
- Diagnostic Log: 16/16 PASS
- Allkirjad UI: 18/18 PASS
- Responsive modal contract: 8/8 PASS
- S1 native signature core: 38/38 PASS
- S1 UI/source contract: 26/26 PASS
- S2 Kontroll production signature: 18/18 PASS
- S3 Parandus production signature: 6/6 PASS
- Fresh-row Kontroll and Parandus controls: 2/2 PASS
- R4 scoring UI/value contract: 10/10 PASS
- XLSX/OOXML preservation: 31/31 PASS
- JavaScript syntax: PASS
- Java/native compilation through targeted native suites: PASS
- `git diff --check`: PASS
- Active production references to `0.5.6.1`: 0
- Package/version metadata: `ee.dold.techcontrol`, `0.5.7`, `58`

### Production XLSX used

The reused-row, fresh-row, import, Rich Data/Picture-in-Cell, formula, Data Validation, metadata, relationship, ZIP, export/re-import, and idempotency checks used a test copy of:

`DOLD_elektrikilbi_sisekontroll_v1.3(4).xlsx`

The original workbook was not modified. The unavailable filename `DOLD_elektrikilbi_sisekontroll_v1.3(7).xlsx` was not claimed or used.

The broader R5 archive-preservation suite also used its historical approved fixture `DOLD_TechControl_allkirjad_prototuup_v0.8.3.xlsx` for compatibility coverage.

## Known legacy assertions / limitations

- **KNOWN PRE-EXISTING LEGACY ASSERTION:** the historical single-frame R3 oversized-package fixture expects `STARTED`, while the legacy single-frame path correctly returns `PAYLOAD_TOO_LARGE`. The current chunked large-package path passed.
- **KNOWN PRE-EXISTING LEGACY ASSERTION:** an old `.dtcs` regression expects exactly two operations, while the production v1.3 workbook already contains 427 historical journal operations and produces 429 after the test action. Production code was not changed for this stale count.
- The R3 legacy no-AA migration case was not run because its required v1.1 fixture was not present in the recovered workspace. Six current persistent-ID cycle cases passed.

## Physical acceptance still pending

1. Install v0.5.7 on OnePlus 13.
2. Install v0.5.7 on CAT S42.
3. Production v1.3 reused-row Kontroll signature.
4. Production v1.3 reused-row Parandus signature.
5. Export XLSX.
6. Microsoft Excel Desktop open/save/reopen.
7. Large QR/LAN baseline.
8. A → B sync.
9. B → A sync.
10. Repeat sync without duplicates.
11. `.dtcs` Android Share / Quick Share / Bluetooth.
12. `KOPEERI LOGI`.
13. Diagnostic UI on both phones.
14. Allkirjad UI on CAT S42.

These physical checks are pending and are not blockers for the local status **READY FOR GITHUB**.
