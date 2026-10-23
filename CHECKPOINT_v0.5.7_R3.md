# DOLD TechControl v0.5.7 — R3 Cycle Identity Checkpoint

## DONE

- Continued from verified R2 commit `4fb73d96a1a2e5bdb57b14ad1ea151ab8049d2d9` on branch `foundation-v0.5.7`.
- Fixed current-cycle reconciliation so a valid `KontrollID` (`Kontrollid!AA` / semantic `entityId`) identifies the inspection before any row or fingerprint cache.
- Added semantic cycle merge for compatible local and incoming cycle state. It unions unique EK entries and preserves primary/additional `KontrollID` values, local work, and prior-control defect links. Missing or incompatible incoming cycle metadata cannot replace the phone's active cycle during a safe merge.
- Kept legacy row/fingerprint recovery for records without persistent IDs. A uniquely matched legacy entry is migrated to its stable sync ID; close Excel start-time values are normalized to seconds for that legacy match.
- Updated cycle creation and sync value extraction to carry/use permanent inspection IDs, including multiple `KontrollID`s for one EK.
- No workbook structure, sync schema 1, LAN protocol, package ID, app version, or entity-ID architecture was changed.

## ROOT CAUSE

The confirmed `4 → 1` loss was in the XLSX import/merge cycle selection. `importXlsx()` merged cycle entries only when local and embedded `cycle.id` matched. If the imported workbook carried older/different cycle metadata, it selected that embedded cycle wholesale. The workbook still contained all four `Kontrollid` rows, but only the one entry in the selected metadata was considered checked after `hydrateHistory()` / `reconcileCycle()`.

The existing lookup path could also lose an association after row movement or W rounding: `ensureSyncState()`, `reconcileCycle()`, and `savedEntry()` still fell through to row plus an exact fingerprint even when a `KontrollID` existed. `cycleFromRecords()` also omitted `kontrollId` and overwrote earlier same-EK entries.

Before the fix, a focused end-to-end import reproduction failed with `actual: 1, expected: 4`. The same reproduction now restores all four checks.

## VERIFIED

| Test set | Result | Fixture / notes |
|---|---:|---|
| Comprehensive legacy regression | **130/130 PASS** | v1.1 workbook; includes the existing R3 QR/bootstrap tests |
| Existing R3 QR/bootstrap regression within legacy suite | **38/38 PASS** | Included in the 130-test run |
| R4 business sync group within legacy suite | **46/46 PASS** | Existing tests retained |
| R5 safety group within legacy suite | **98/98 PASS** | Existing tests retained |
| R1 package routing | **10/10 PASS** | v0.8.3 workbook |
| R1 persistent-ID hydration | **1/1 PASS** | v0.8.3 workbook |
| R2 persistent-ID targeted tests | **2/2 PASS** | v0.8.3 workbook |
| R3 cycle identity tests | **7/7 PASS** | Six cases on v0.8.3 plus one legacy no-AA migration case on v1.1 |
| JavaScript syntax checks | **PASS** | App controller and headless test harness |
| `git diff --check` | **PASS** | Before checkpoint creation |

R3 cycle cases cover: local cycle fuller than stale incoming metadata; incoming cycle fuller than local; identical entries; missing incoming cycle metadata with IDs in `AA`; moved control rows with slightly rounded `W`; additional control IDs and prior defect links; and unambiguous legacy migration without `AA`.

## BLOCKER / LIMITATIONS

- No R3 cycle-identity blocker remains in headless verification.
- Android SDK, Gradle, and adb are unavailable here. No APK was built and no physical-phone verification was performed.
- During an exploratory broad R3 run against the larger v0.8.3 workbook, an existing direct-baseline host test returned `PAYLOAD_TOO_LARGE` before its no-network assertion. LAN transport was outside R3 and was not changed; the existing R3 transport suite passes in the full legacy run. Track the v0.8.3 baseline-size limit separately if that workbook must be bootstrapped directly over LAN.
- Package/version remain `ee.dold.techcontrol`, `0.5.6.1` / code `57`. No release version bump was made.

## COMMITS

- R3 implementation commit: `9d65800ae792495d57c50f2528e63d61db083e80`
- R3 checkpoint commit: this checkpoint is committed separately after the implementation commit.
- Branch: `foundation-v0.5.7`; not pushed to `main`.

## NEXT

R4 may be planned after review of this checkpoint. No R4 implementation was started.

The full-project ZIP and its SHA-256 are provided alongside this checkpoint. The archive hash is kept outside this file because this checkpoint itself is included in the archive.
