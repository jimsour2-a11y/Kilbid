# DOLD TechControl v0.5.5 — Checkpoint Stage 6

## DONE

- Sync package import presents a preview and distinguishes parallel synchronization from full `.dtc` handoff.
- Field conflict resolution is applied to the same logical workbook entity.
- The DOLD conflict dialog provides the two requested choices: retain this phone's value or use the other phone's value.
- The selected value and its resolution operation are durably committed together; existing Puudus rows are updated in place.
- Resolution operations carry the field versions they settle. The peer recognizes this causal choice, updates its version, and closes the matching conflict without another prompt.
- Fixed invalid conflict lookup ordering so missing conflict metadata produces a controlled error instead of dereferencing null.
- Added an end-to-end two-store test: both phones edit the same Puudus owner field, one phone chooses the incoming value, and the resolution delta converges on the peer without a remaining conflict.
- Preserved the existing separate `.dtc` full-handoff path.

## VERIFIED

- `node --check app/src/main/assets/DOLD_TechControl_v0.5.3.js` — PASS.
- `node --check tests/headless-regression.cjs` — PASS.
- Focused conflict tests — 2/2 PASS.
- Full regression suite — **29/29 PASS**, including all 23 v0.5.4 baseline tests and 6 v0.5.5 tests.
- Full result JSON: `/tmp/dtc-v055-stage6-full/results.json`.
- Current workbook fixture loaded as 280 registry cabinets / 250 active cabinets.
- Android SDK/Gradle/ADB are unavailable in this environment; no Android build or device test was run in this stage.
- No Git repository is present in the working directory; this markdown checkpoint is the persistent stage record.

## REMAINS

- Continue Stage 7 duplicate-inspection flow and add its focused tests.
- Real Android/WebView validation remains necessary later; this stage used the existing Node XML/form adapter.
