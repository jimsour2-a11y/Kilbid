# DOLD TechControl v0.5.7 — S1 signature-capture checkpoint

## DONE

- Added a native Android signature pad for local S1 drafts, with finger-only input, raw normalized points, stroke numbering, monotonic timing, cancellation, and a generated PNG preview.
- Added per-capture `AllkiriID` and nonce generation, canonical metadata hashing, PNG/stroke/geometry hashes, and atomic persistence under the app's private `filesDir/signature-drafts-s1` directory. Draft metadata, raw points, and PNG are stored together and survive app restart.
- Added local duplicate-capture checks. The registry only asserts uniqueness when it was read and validated; a corrupt registry is reported as not checked and never as unique.
- Added native Estonian capture actions and local draft listing. The saved-inspection UI exposes `ALLKIRJA MUSTAND`; the JS bridge only starts capture or lists local drafts.
- Kept signature capture outside the business workbook transaction. This stage does not write `Allkirjad`, `Allkirja_jaljed`, `Allkirjade pildid`, `Kontrollid!AB/AC`, `Parandused!I/J`, or `Kehtiv`, and does not mark a signature valid or completed.
- Kept the existing branch and release metadata: `foundation-v0.5.7`, package `ee.dold.techcontrol`, `versionName 0.5.6.1`, `versionCode 57`. No push to `main` was made.

### Identity and rendering boundaries

- A `Kontroll` capture carries a positive record version only when the current saved values match the schema-1 semantic revision. If that proof is absent or stale, its version is `null` with source `UNRESOLVED`; the app does not invent version `1`.
- A `Parandus` capture uses its supplied positive `Parandused!L` version only when available; otherwise it remains `UNRESOLVED`.
- The PNG renderer is explicitly experimental: `dold-s1-experimental-raster-v1;white-rgba;black-round-2pct;png-deflate-6`. It is not a production signature-rendering profile.
- Duplicate detection is local to this app installation's saved S1 draft registry. It does not establish global uniqueness across phones or against accepted XLSX signatures.

## VERIFIED

| Test set | Result |
|---|---:|
| Full headless regression on the supplied v1.1 workbook | **143/143 PASS** |
| S1 native capture core and draft store | **26/26 PASS** |
| S1 Android UI/source contract | **15/15 PASS** |
| R1 package routing / handoff | **10/10 PASS** |
| R1 persistent-ID hydration | **1/1 PASS** |
| R2 persistent-ID targeted tests | **2/2 PASS** |
| R2 LAN transport | **23/23 PASS** |
| R3 cycle identity | **7/7 PASS** |
| R3 QR/bootstrap | **38/38 PASS** |
| R4 scoring | **10/10 PASS** |
| R4 semantic sync | **46/46 PASS** |
| R4 native LAN | **4/4 PASS** |
| R5 sync safety | **98/98 PASS** |
| R5 v0.9.0 XLSX preservation round-trip | **31/31 PASS** |
| R5 responsive-dialog contract | **8/8 PASS** |
| v0.5.6.1 field-fix JS / native tests | **11/11 + 4/4 PASS** |
| JavaScript syntax checks | **PASS** |
| `git diff --check` | **PASS** |

The 143-test headless run includes the S1 controller checks: saved-inspection invocation with a known semantic version, unresolved version when values differ, and local-only draft listing without workbook writes. The S1 Java test uses the JDK compiler module and passed with `bash tests/signature/run-signature-s1-tests.sh`.

The v0.9.0 preservation fixture was checked at SHA-256 `dc4cdb2beefb4502c9a75441d4042160e8619c33959a932b37daa433f45c4e57`; the separate v1.1 regression fixture was checked at SHA-256 `3e65fcd07299dd9a71426d136459bf38b6fa9c3cee3b04a271cc44d1173fe25a`. Existing signature-prototype sheets and related OOXML parts were not changed by S1.

### Regression harness correction

One R4 score-save assertion used a row count captured before earlier test cases had inserted records. Its baseline is now captured immediately before the seven score saves; the test still checks all seven exact H values, preserves blank versus `0`, and requires exactly seven additional rows. This fixes test isolation and does not weaken the assertion.

## BLOCKER / LIMITATIONS

- Android SDK, Gradle, and `adb` are unavailable in this environment. **APK NOT BUILT IN THIS ENVIRONMENT.** Native capture UI has not been physically exercised on Android or CAT S42.
- A production-grade record-version source is not established for legacy/stale `Kontroll` records; these drafts correctly remain `UNRESOLVED` until a trusted revision is available.
- The raster rendering profile is experimental and must be agreed before production signature acceptance.
- Local anti-reuse checks do not prevent the same hand signature from being captured on another device.
- No XLSX signature commit, signature sync, production signing, or S2 behavior is implemented in this checkpoint.

## COMMITS AND SOURCE

- R5 checkpoint parent: `15f927589d33054590ee9e0dcd1ffd649db4836a`
- S1 implementation commit: `59814f885bf72c2111f32d5d3b60cb28e33432d0`
- S1 checkpoint commit: the separate commit adding this checkpoint file.
- Branch: `foundation-v0.5.7` (local; not pushed to `main`).

## NEXT

Wait for the production signature workbook/schema before considering the next stage. Do not start S2 automatically.
