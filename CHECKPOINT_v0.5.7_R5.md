# DOLD TechControl v0.5.7 — R5 pre-production hardening checkpoint

## DONE

- Continued on `foundation-v0.5.7` from the R4 checkpoint. No R1–R4 behavior, cycle identity, semantic sync, LAN protocol, package ID, or release version was changed.
- Added an application-controlled XLSX round-trip test using the current app importer, save, export path, and re-import path on a separate copy of the supplied Microsoft Excel prototype.
- Changed the shared app dialog shell so the card is constrained by the available viewport and Android safe areas. The title and action footer remain outside the scrolling body; long dialog content scrolls independently. The prior 560px desktop width cap remains.
- Added a responsive CSS/DOM contract test and a CAT S42 manual verification checklist below.
- Measured the v0.8.3 direct baseline package against the existing transport limit. The transport and its limit were not changed.

## XLSX preservation result

Fixture: `DOLD_TechControl_allkirjad_prototuup_v0.8.3(3).xlsx`

SHA-256: `df46a0b0509a04ad299f414331111f27ff088452e72685fce0569c70222be7c8`

Input size: 2,009,828 bytes; 54 OOXML archive parts; 13 worksheets.

Baseline business counts were read from the fixture before the controlled app write:

| Record set | Before | After test record |
|---|---:|---:|
| Kontroll records | 81 | 82 |
| Puudused records | 144 | 145 |
| Existing KontrollID values | 81 | 82 |
| Existing PuudusID values | 142 | 143 |

The test added one controlled Android inspection and one linked test defect, exported through the app path, then re-imported the exported workbook through the app. Every pre-existing ID value remained unchanged. `Puudused!S23` and `S25` remained empty; all existing `Puudused!T` links and all 22 rows carrying `UNRESOLVED` / `LEGACY MATCH ONLY` status or basis remained unchanged. The new test KontrollID and PuudusID and their relationship survived re-import.

Structural verification passed **31/31 assertions**:

- all original sheet names and all 54 original parts remain;
- all internal OOXML relationship targets resolve; existing relationships other than root metadata links remain unchanged;
- the 10 `xl/drawings/**` parts, 10 `xl/media/**` items, five `xl/richData/**` parts, and `xl/metadata.xml` remain byte-for-byte unchanged;
- all 46 parts outside the app's expected write set remain byte-for-byte unchanged;
- `Parandused`, `Allkirjad`, `Allkirjade pildid`, and `Kontrollakt Auto` sheet XML remains unchanged, so prototype test records were not changed into production records;
- all 37,783 formulas remain present with unchanged formula expressions;
- defined names / print areas, page setup, drawings references, merged cells, and conditional formatting remain unchanged;
- `docProps/custom.xml`, workbook metadata, styles, and the three app-managed sheets are in the expected write set. The app updates its own embedded state there.

### Direct baseline size observation

Measured from the app-generated baseline `.dtcs` after the controlled save:

| Item | Size |
|---|---:|
| Source XLSX | 2,009,828 bytes |
| `.dtcs` baseline package | 1,771,056 bytes |
| Embedded `workbook.xlsx` entry | 1,931,335 bytes |
| Embedded `state.json` entry | 677,967 bytes |
| Existing LAN maximum | 1,048,576 bytes (1 MiB) |
| Package over limit | 722,480 bytes |

The large v0.8.3 baseline therefore remains a known `PAYLOAD_TOO_LARGE` case for direct LAN bootstrap. This checkpoint only records the measurement; protocol, framing, limit, and compression were not altered.

## Responsive dialog result

The shared `appDialog` now has:

- an overlay padded by `safe-area-inset-top` and `safe-area-inset-bottom`;
- a flex-column card with a viewport-aware `max-height` using `vh` fallback and `dvh` support;
- a fixed-size title region, independently scrollable body (`overflow-y:auto`, `min-height:0`), and separate reachable action footer;
- the previous `min(560px, 100%)` width behavior for large screens.

All existing choice dialogs and direct-sync status/summary screens use the same responsive shell. Responsive contract checks passed **8/8**. This is a headless DOM/CSS contract, not a measurement on a physical CAT S42.

### CAT S42 / large-phone manual checklist

- [ ] On CAT S42 portrait, open a long `SÜNKROONITUD` result; scroll the message and confirm the bottom action stays available.
- [ ] Confirm Android navigation controls do not cover the last action.
- [ ] Check sync preview and a long conflict dialog; scroll all details and use each decision button.
- [ ] Check import/workspace comparison, direct/bootstrap summary, and long warning/error dialogs.
- [ ] Repeat on a large modern phone and confirm the prior centered, width-capped layout remains comfortable.

## VERIFIED

| Test set | Result |
|---|---:|
| Legacy regression | **130/130 PASS** |
| R1 package routing / handoff | **10/10 PASS** |
| R1 persistent-ID hydration | **1/1 PASS** |
| R2 persistent-ID tests | **2/2 PASS** |
| R3 cycle identity | **7/7 PASS** |
| R3 QR/bootstrap | **38/38 PASS** |
| R4 score labels and persistence | **10/10 PASS** |
| R4 semantic bidirectional sync | **46/46 PASS** |
| R5 sync safety | **98/98 PASS** |
| R5 v0.8.3 XLSX structure round-trip | **31/31 PASS** |
| R5 responsive dialog contract | **8/8 PASS** |
| JavaScript syntax checks | **PASS** |
| `git diff --check` | **PASS** |

The R5 workbook test ran through the real JavaScript app controller and a filesystem-backed headless bridge. It does not substitute for opening the exported workbook in desktop Excel or testing Android WebView viewport behavior on a phone.

## BLOCKER / LIMITATIONS

- No code blocker remains in headless verification.
- Physical CAT S42 and large-phone verification remains pending.
- Android SDK, Gradle, and `adb` are unavailable here; no APK was built and no physical-device test is claimed.
- The v0.8.3 direct baseline exceeds the unchanged 1 MiB LAN limit by 722,480 bytes, as measured above.
- One exploratory full test invocation used the v0.8.3 prototype as the legacy-suite fixture and hit a legacy journal assertion intended for the v1.1 field workbook. The required legacy regression was then run against the supplied v1.1 fixture and passed 130/130. No test was weakened.

## Files and commits

Files changed:

- `app/src/main/assets/index.html`
- `tests/headless-regression.cjs`
- `tests/responsive-modal.test.cjs`
- `CHECKPOINT_v0.5.7_R5.md`

Implementation commit: `1d5c9fd1f09fe6385bd2d805ab9286cf47decd8c`

Branch: `foundation-v0.5.7`

Package: `ee.dold.techcontrol`

Current app metadata remains `versionName 0.5.6.1`, `versionCode 57`; no release bump was requested.

## NEXT

Wait for the production signature workbook/schema from the spreadsheet project. Do not start the next stage until that is ready. Do not implement signature sync or production signatures from this prototype.
