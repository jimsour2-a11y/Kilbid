# DOLD TechControl foundation — R2 persistent write IDs

## DONE
- New inspections receive a random persistent `dtc-kontroll-*` ID before their `Kontrollid` row is committed. `Kontrollid!AA` is written with that exact ID, which is also the semantic sync `entityId`.
- A newly created defect receives a random persistent `dtc-puudus-*` ID in `Puudused!S`. `Puudused!T` links it to the current inspection ID; `U=DIRECT` and `V=ANDROID CREATE` record the explicit Android-created link.
- Editing an existing inspection reuses its existing logical ID and row. Existing defect IDs are retained; no extra defect or inspection is created by the edit path.
- Incoming semantic operations write their exact `entityId` to `Kontrollid!AA` or `Puudused!S`. `Puudused!T` is written only when the operation explicitly carries a valid `kontrollId`.
- Incoming updates to blank-ID `UNRESOLVED` legacy defects do not populate their ID or control-link cells and leave their U/V provenance/status cells unchanged.
- Existing conflicting or malformed workbook IDs cause the transaction to fail safely rather than replacing an ID. No sync schema or `changedFields` whitelist was extended.

## VERIFIED
- R2 targeted tests on the supplied v0.8.3 workbook: **2/2 PASS**. Covers local save, same-row edit, persistent IDs and direct defect link; incoming operation IDs; current-cycle reconstruction; and keeping a legacy unresolved row unresolved.
- R1 persistent-ID hydration check on v0.8.3: **1/1 PASS**.
- R1 package-routing regression on v0.8.3: **10/10 PASS**.
- Full comprehensive headless regression on the v1.1 legacy fixture: **130/130 PASS** (the prior 128 checks plus both R2 cases). No existing test was removed or weakened.
- `node --check` for the app JS and test harness, and `git diff --check`: PASS.
- The supplied XLSX was only read by the harness; its source file was not modified.
- Package/version remain `ee.dold.techcontrol`, `0.5.6.1` / `57`. No APK was built because Android SDK, Gradle and adb are unavailable in this environment.

## BLOCKER
- The R1-known v0.8.3 current-cycle merge issue remains: after reimporting a future-sheet workbook, checked progress can fall from 4 to 1. R2 does not change cycle reconciliation; this remains for R3.
- Physical Android install and two-phone checks are unavailable here.

## NEXT
- R3: fix current-cycle association using persistent `KontrollID` first, without changing the workbook or sync schema.
- Work remains on local branch `foundation-v0.5.7`; nothing was pushed or merged to `main`.

## Files changed in R2
- `app/src/main/assets/DOLD_TechControl_v0.5.3.js`
- `tests/headless-regression.cjs`
- `CHECKPOINT_v0.5.7_R2.md`
