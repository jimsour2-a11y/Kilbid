# DOLD TechControl foundation — R0 baseline

## DONE
- Verified repository `jimsour2-a11y/Kilbid`, branch `main`, source commit `6498760a0d0d3d9d234d0916434408b6a63ce473` (`DOLD TechControl v0.5.6.1`).
- Created local branch `foundation-v0.5.7`; nothing was pushed or merged.
- Confirmed Gradle values: package `ee.dold.techcontrol`, versionName `0.5.6.1`, versionCode `57`.
- Inspected uploaded v0.8.3 workbook read-only. It has 13 sheets, 81 `Kontrollid!AA` IDs, 144 defects, 142 `PuudusID`s, missing IDs at Puudused rows 23 and 25, 5 `xl/richData` package parts, and 10 media parts.
- Corrected the regression's obsolete fixed sheet-count assertion. It now verifies exact source/output sheet-name equality and checks the loaded sheet count against the source. No assertion was removed.

## VERIFIED
- Original comprehensive headless suite: `PASS ALL 127` on the v1.1 fixture supplied for legacy baseline.
- R0 companion suites: field-fix JS 11/11, field-fix native 4/4, LAN transport 23/23, R4 native LAN 4/4 PASS.
- v0.8.3 import/export ZIP-preservation assertion passes, including exact sheet names and unchanged non-editable package parts.
- The original XLSX bytes were not modified. v0.8.3 SHA-256 is in `V0.8.3_SHA256.txt` in the checkpoint package.

## BLOCKER
- On the v0.8.3 fixture, current v0.5.6.1 loses 3 of 4 checked items after merging an externally added future sheet (assertion: 1 != 4). This is the persistent-ID/current-cycle issue targeted in R1/R3; source code is still unchanged.
- The legacy test's hard-coded 2026-09-24 cycle sample is valid for the v0.8.3 fixture but not for the older 22.09 fixtures. The full legacy regression was run against the v1.1 fixture.
- Android SDK, Gradle and adb are unavailable; APK build/physical test cannot be performed here.

## NEXT
- R1: hydrate persistent `KontrollID` / `PuudusID` and keep deterministic IDs only as fallback, protecting unresolved rows 23 and 25.
