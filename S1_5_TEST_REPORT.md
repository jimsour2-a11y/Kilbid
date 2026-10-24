# DOLD TechControl v0.5.7 — S1.5 verification report

## Regression results

| Test set | Result |
|---|---:|
| Expanded full headless suite on supplied v1.1 fixture, with R3 cycle cases and S1.5 enabled | **152/152 PASS** |
| S1.5 focused recordVersion / legacy / G-T formulas | **3/3 PASS** |
| R1 package routing and handoff cases | **10/10 PASS** |
| R1 persistent-ID hydration | **1/1 PASS** |
| R2 persistent-ID tests | **2/2 PASS** |
| R2 native LAN transport | **23/23 PASS** |
| R3 current-cycle identity | **7/7 PASS** |
| R3 QR/bootstrap | **38/38 PASS** |
| R4 score UI/persistence | **10/10 PASS** |
| R4 semantic bidirectional sync | **46/46 PASS** |
| R4 native LAN | **4/4 PASS** |
| R5 sync safety | **98/98 PASS** |
| R5 app XLSX preservation round-trip on the supplied R4 v0.9.0 source | **31/31 PASS** |
| R5 responsive modal contract | **8/8 PASS** |
| v0.5.6.1 field-fix JS/native | **11/11 + 4/4 PASS** |
| S1 native capture core / draft store | **30/30 PASS** |
| S1 native UI/source contract | **15/15 PASS** |
| JavaScript syntax checks | **PASS** |
| `git diff --check` | **PASS** |

The existing R5 legacy suite baseline was **130/130 PASS**. The expanded current full headless run is 152/152 and includes the current legacy behavior plus R1–R4 cases, S1 capture/controller checks, R3 cycle cases, and the S1.5 tests. No old test was removed or weakened.

## S1.5 assertions

- An unchanged persistent `KontrollID` keeps its recordVersion after repeated lookup, WorkspaceStore restart, and XLSX export/import.
- Moving the `Kontrollid` row does not change recordVersion; editing score `H` advances it exactly once.
- A legacy record without `Kontrollid!AA` stays `UNRESOLVED`.
- Formula generation requires exactly one target ID, fails closed on missing/duplicate/invalid targets, compares blank/type/value distinctly, uses every prescribed snapshot mapping, and stays under 8,192 characters.
- Renderer golden vector decodes as transparent 900×300 PNG; PNG hash matches the fixed test vector.
- Local anti-reuse golden digests, duplicate indicators, complete-empty registry, corrupt registry, draft restart persistence, and legacy renderer-profile decoding passed in the native core test set.
- POC archive integrity and XML parsing passed; 14 sheet names preserved; all 43 internal relationships resolve; all 55 original parts remain; 10 drawing parts and 10 existing media items remain byte-identical; `Allkirjad`, reserved `F8`, existing formulas, Rich Data indexes, and metadata indexes are preserved; `F9` points to the new PNG and `G9` matches its SHA-256.
- Input/POC business baseline compared: 82 KontrollID values, 145 Puudused rows, 143 PuudusID values, empty S23/S25, 141 Puudused T links, and 22 legacy-link markers. All remain unchanged.

## Not tested in this environment

- **Microsoft Excel Desktop: NOT TESTED.** The POC still needs the manual checklist in `S1_5_EXCEL_DESKTOP_CHECKLIST.md` to verify rendering, selector behavior, save/reopen, Camera behavior, and print previews.
- **Physical Android: NOT TESTED.** No phone test was run for the new canonical PNG renderer or signature capture UI.
- **APK build: NOT TESTED.** Android SDK, Gradle, `adb`, `ANDROID_HOME`, and `ANDROID_SDK_ROOT` are unavailable in this environment.

The full headless adapter is Node VM plus XML/form and filesystem-backed bridge, not Android WebView. Passing headless tests does not substitute for those device/Excel checks.

## Known separate issue

The existing v0.8.3 `.dtcs` direct baseline remains 1,771,056 bytes, 722,480 bytes above the unchanged 1 MiB LAN limit. S1.5 did not modify the LAN protocol or limit.
