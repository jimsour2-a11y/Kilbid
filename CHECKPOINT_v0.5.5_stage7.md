# DOLD TechControl v0.5.5 — Checkpoint Stage 7

## DONE

- Opening an EK already inspected in the current Kontroll cycle now shows a DOLD dialog with inspection time, inspector, and linked-defect count.
- The dialog offers `VAATA KONTROLLI`, `MUUDA KONTROLLI`, and `UUS KONTROLL`.
- Viewing is a read-only DOLD view and does not start the inspection timer.
- Editing resolves by stable `KontrollID` and updates the same logical inspection row.
- Creating a second same-cycle inspection requires a second explicit confirmation and receives a new stable KontrollID.
- The new inspection replaces the cycle’s primary record pointer; the earlier KontrollID remains in `additionalKontrollIds`. The cabinet remains a single checked item in cycle progress.
- Existing Puudus-to-Kontroll relationships are retained when creating another same-cycle inspection; old defect rows do not produce incidental update operations.
- Historical inspections from a previous cycle do not trigger the duplicate-current-cycle warning.
- Cycle restoration prefers stable KontrollID before row/fingerprint fallback.

## VERIFIED

- `node --check app/src/main/assets/DOLD_TechControl_v0.5.3.js` — PASS.
- `node --check tests/headless-regression.cjs` — PASS.
- Focused duplicate inspection test — PASS.
- Full regression suite — **30/30 PASS**, including all 23 v0.5.4 baseline tests.
- Full result JSON: `/tmp/dtc-v055-stage7-full/results.json`.
- Test covers read-only/no timer, edit same ID, explicit new inspection, stable progress count, and historical inspection behavior.
- Android SDK/Gradle/ADB remain unavailable; this was a headless controller test, not a real Android/WebView test.
- No Git repository is available; this checkpoint markdown is the stage record.

## REMAINS

- Implement/evaluate QR pairing as an additional transport over the same `.dtcs` engine (Stage 8); retain Share regardless.
- Continue Stage 9 UI review and Stage 10–12 test/build package work.
