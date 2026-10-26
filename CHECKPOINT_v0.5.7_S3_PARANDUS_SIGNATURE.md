# DOLD TechControl v0.5.7 — S3 Parandus signature checkpoint

## Baseline and scope

- Branch: `foundation-v0.5.7`
- Starting implementation baseline: `6aa659ce7adb91e0b90310c376e9ae7b25d51f65`
- S3 implementation commit: `ef7063d00c1e8e3c621acb84b73705e869b693e5`
- Android package/version preserved: `ee.dold.techcontrol`, `0.5.6.1`, version code `57`
- `main`, XLSX files, LAN transport, sync schema and signature synchronization were not changed.
- S2 `Kontroll` production signing remains the existing implementation; S3 reuses its renderer v2, native capture, hashes, proof, anti-reuse and atomic XLSX commit path.

## Preflight / approved Parandused contract

The requested `DOLD_Signature_Android_XLSX_Contract_R4.md` was not present in the supplied workspace. The approved R4 workbook was inspected directly: `DOLD_TechControl_allkirjad_prototuup_v0.9.0_R4_checkpoint(2).xlsx`.

The workbook already supplies the required production target and links; no new workbook schema was needed:

| Parandused column | Contract field |
|---|---|
| A | ParandusID |
| B | EK ID |
| C | PuudusID |
| D | Teostas |
| E | Töö aeg UTC |
| F | Tehtud töö |
| G | Kontrollis |
| H | Töö olek |
| I | AllkiriID |
| J | Allkirja olek |
| K | Allkiri (TEST) |
| L | Versioon |
| M | Test |
| N | KontrollID |
| O | Täpne UTC |

`Parandused!J5` contains the approved signature-status formula template. `Allkirjad` has target snapshots in AM:AW for Parandused fields B,C,D,E,F,G,H,L,M,N,O. The existing `Kontrollakt Auto` formulas resolve repair signatures by `TargetType=Parandus` and permanent `ParandusID`. The workbook includes TEST data; live app hydration excludes TEST-marked rows.

Version source is `PARANDUSED_L`; record snapshot format is `dold-parandus/v2`. The protected record snapshot uses the approved target identity/version and repair fields: permanent ID/version, EK, linked PuudusID and KontrollID, performer, UTC time, work text, checker and work status.

## Implementation

- Root cause: before S3, repair completion updated/closed the existing `Puudused` row only. It did not create a durable `Parandused` record with a permanent ParandusID, so the app had no unambiguous repair target to pass into signature capture.
- A successful repair close persists a permanent `dtc-work-…` Parandus row before requesting signature capture.
- Capture is opened against the just-persisted ParandusID, not the cabinet ID or worksheet row. The existing native dialog receives target type, repair ID, EK, signer and version/source metadata.
- Production commit uses the existing S2 pipeline and R4 sheets. It writes the Parandus pointer/status to `Parandused!I/J`; it does not change `Kontrollid!AB` or Kontroll version state.
- All touch points, v2 canonical PNG, existing anti-reuse, RecordHash, StrokeHash, PNGHash, ProofHash and Rich Data transaction rules are reused.
- Capture cancel/start failure leaves the saved repair unsigned. A recently completed repair remains available through `VAATA PARANDUST / ALLKIRI` for later signing.
- Unresolved legacy Puudus/Kontroll links fail closed for signing; the repair remains unsigned and no permanent target is fabricated.
- Existing TEST and other OOXML content is preserved by the S3 preservation checks.

## Checkpoint state

**DONE:** S3 Parandus signing implementation, targeted tests, regression and preservation checks are complete.

**VERIFIED:** Full headless regression `177/177 PASS`; targeted S3 `6/6 PASS`; R5 OOXML preservation `31/31 PASS`; S1 native `38/38 PASS`; S1 UI/source contract `26/26 PASS`; JS syntax and `git diff --check` pass. Detailed counts are in `S3_PARANDUS_SIGNATURE_TEST_REPORT.md`.

**BLOCKER:** No Android SDK/Gradle/ADB is available in this environment, so no APK was built and the new Parandus flow has not yet been physically tested. S2 Kontroll’s prior physical confirmation remains the existing baseline, not evidence for S3.

**NEXT:** Build the source through the established GitHub Actions workflow and physically test repair signing on OnePlus 13. Do not begin another development phase automatically.

## Transfer bundle note

The local source clone is shallow at commit `6498760a0d0d3d9d234d0916434408b6a63ce473`. The S3 Git bundle therefore declares this existing commit as a prerequisite and contains the S3 branch updates after it. Import the bundle into the authenticated clone that already contains this base history; it is not a standalone bundle for an empty repository.
