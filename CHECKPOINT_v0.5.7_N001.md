# DOLD TechControl v0.5.7 — N001

## DONE

- Base branch: `foundation-v0.5.7`
- Base HEAD: `060723dbfb72d5ed78cf34ea2376b6d1673a0dbc`
- Implementation commit: `ba9c5d04756d9a01f301645648a8c6d8ec730591`
- Version remains `0.5.7` (`versionCode 58`), package `ee.dold.techcontrol`.
- Fixed the Parandus production-signature commit after repair-mode capture.

## ROOT CAUSE

`commitProductionSignature()` used `TC.ready` as the workbook-open guard. `TC.ready` means that the Kontroll workflow is active; it is deliberately left false when the user opens `PARANDUSED / TÖÖD`. The repair transaction and local signature draft therefore succeeded with an active `S.zip`, but the production commit stopped immediately with `WORKBOOK_NOT_OPEN`.

The guard now checks the actual activated workbook state (`TC.activated` plus `S.zip`). Signature storage, XLSX structure, hashes, IDs, LAN sync, and business logic were not changed.

## VERIFIED

Targeted tests used a copy of `DOLD_elektrikilbi_sisekontroll_v1.3(4).xlsx`.

- Reproduction before fix: FAIL with the field error `WORKBOOK_NOT_OPEN` while `TC.ready=false`, `TC.activated=true`, and `S.zip` present.
- Parandus repair-mode production commit: `1/1 PASS`.
  - 1 stroke / 187 points draft remains in the local draft registry.
  - XLSX pointer and status become `Kehtiv`.
  - Retry returns the existing signature and creates no duplicate.
- Existing Kontroll production-signature commit and idempotent retry: `1/1 PASS`.
- Existing primary S3 Parandus production commit scenario emitted PASS during the targeted S3 run.
- JavaScript syntax: PASS.
- `git diff --check`: PASS.

No full regression suite was run, as this checkpoint is limited to the confirmed field defect.

## CHANGED FILES

- `app/src/main/assets/DOLD_TechControl_v0.5.3.js`
- `tests/headless-regression.cjs`
- `CHECKPOINT_v0.5.7_N001.md`

## BLOCKER

- None in targeted automated verification.
- Physical confirmation on OnePlus 13 and Samsung XCover7 remains pending.

## NEXT

- Build from this checkpoint in the authenticated GitHub environment, then repeat the Parandus signature flow on the two field phones.
- Do not start physical acceptance automatically from this checkpoint.
