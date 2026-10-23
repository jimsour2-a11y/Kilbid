# DOLD TechControl v0.5.7 — R4 inspection rating labels

## DONE

- Continued on `foundation-v0.5.7` from the completed R3 checkpoint. No R1/R2/R3 logic, sync protocol, workbook mapping, score values, or release version was changed.
- Replaced the active inspection UI descriptions with the approved workbook scale:
  - blank — `Ei rakendu`
  - 0 — `Ei ole / puudub`
  - 1 — `Asendus puudub`
  - 2 — `Ajutised lahendused`
  - 3 — `Vajab uuendamist`
  - 4 — `Normi piires`
  - 5 — `Uus ja korras`
- Made the `SCORE_INFO` map the single source for the dynamically rendered inspection legend and helper, the 0 confirmation text, and saved-inspection detail labels. The empty value and numeric 0 remain distinct.
- Updated the helper text so `–` means `Ei rakendu`. Saved-inspection detail now shows the number and its matching description.
- Updated the current README scoring note. The versioned v0.5.4 test report was left intact as a historical record of that release.
- Added 10 focused R4 tests. They cover the seven labels, inspection detail, persisted H values `0`–`5` plus blank, and edit-save score preservation.

## Where the old text was found

- `app/src/main/assets/index.html`: a hard-coded six-row legend and a separate `SCORE_INFO` dictionary held duplicate descriptions. The helper also described the empty mark as `täitmata`.
- `app/src/main/assets/DOLD_TechControl_v0.5.3.js`: saved-inspection detail showed only raw scores, without scale descriptions.
- `README.md`: said the score-semantics conflict remained unresolved.

The duplicated UI labels now come from one `SCORE_INFO` map. Defect grades A–D use their separate existing `GRADE_INFO` map and were not changed.

## VERIFIED

| Test set | Result | Notes |
|---|---:|---|
| Original legacy regression | **130/130 PASS** | v1.1 workbook; all checks also passed as part of the final expanded run |
| Extended legacy + R3 cycle run | **137/137 PASS** | Final code; 130 legacy checks plus seven opt-in R3 cycle tests; no R4 scoring tests included |
| R1 package routing | **10/10 PASS** | v0.8.3 workbook |
| R1 persistent-ID hydration | **1/1 PASS** | v0.8.3 workbook |
| R2 persistent-ID tests | **2/2 PASS** | v0.8.3 workbook |
| R3 cycle identity tests | **7/7 PASS** | Included in the 137-check run |
| R3 QR/bootstrap tests | **38/38 PASS** | Included in both legacy runs |
| R4 score UI/persistence tests | **10/10 PASS** | Separate targeted run |
| R4 semantic sync regression | **46/46 PASS** | Included in legacy runs |
| R5 safety regression | **98/98 PASS** | Included in legacy runs |
| JavaScript syntax | **PASS** | Controller, headless harness, and inline app script |
| `git diff --check` | **PASS** | |

No existing test was deleted or weakened. Tests confirm `Kontrollid!H` still receives the same numeric values; blank remains an empty cell. Editing an existing inspection without changing its scores preserves H:R.

## BLOCKER / LIMITATIONS

- No R4 code blocker remains in headless verification.
- Direct LAN baseline transfer for the larger v0.8.3 workbook has a separate observed `PAYLOAD_TOO_LARGE` limitation. R4 did not change LAN transport, its 1 MiB limit, compression, or QR protocol.
- No APK was built and no physical Android test was performed. Android SDK/Gradle/adb are unavailable in this environment.
- Package/version remain `ee.dold.techcontrol`, `0.5.6.1` / code `57`; no release bump was requested.

## FILES CHANGED

- `app/src/main/assets/index.html`
- `app/src/main/assets/DOLD_TechControl_v0.5.3.js`
- `tests/headless-regression.cjs`
- `README.md`

## COMMITS

- R4 implementation: `9e53778` (`Align inspection rating labels with workbook scale`)
- R4 checkpoint: added in a separate commit after implementation verification
- R3 checkpoint parent: `e69b077`
- Branch: `foundation-v0.5.7`; not pushed to `main`.

## NEXT

Review the R4 source ZIP and checkpoint. Do not begin R5 until requested.
