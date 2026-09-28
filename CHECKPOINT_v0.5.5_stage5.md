# DOLD TechControl v0.5.5 — Stage 5 checkpoint

## DONE

- Added `DOLD-TECHCONTROL-SYNC-PACKAGE` `.dtcs` baseline and delta modes, separate from the existing `.dtc` full handoff.
- Baseline mode contains the full XLSX plus sync state. It omits the sender installation's device ID and local presence guard. The receiving app keeps its own device ID and creates its own presence guard while retaining dbId, epoch, cycle, and stable record IDs.
- Delta mode contains only `operations.json` and a manifest with dbId, epoch, sender ID, source app version, operation count, summary, byte size, and SHA-256 hash. It does not include the XLSX.
- Added Android Share/Quick Share output for preparing a second phone and sending changes. Added `.dtcs` file import routing and a separate Andmed synchronization section while leaving `.dtc` actions/semantics separate.
- A second installation receives its own operation sequence keyed by its device ID. The counter is not copied as the receiver's identity.
- Added preview counts for inspections, new defects, repairs, other changes, duplicates, and predicted field conflicts.
- Delta import validates ZIP CRCs, SHA-256, byte count, dbId, and epoch before changes. Successful merge records peer acknowledgements within the same transaction.
- Added test coverage for two-way `.dtcs` exchange, duplicate package re-import, wrong-db rejection, corrupt package rejection, and baseline device identity isolation.

## VERIFIED

- `.dtcs` baseline/round-trip focused test passed.
- Delta package contains no XLSX; baseline state contains no deviceId or camera-presence guard.
- The receiving phone keeps its own deviceId and receives the sender dbId/epoch/stable entity IDs.
- Existing full `.dtc` handoff tests still pass.
- Combined regression suite: **28/28 PASS** against the current 280-cabinet/250-active workbook fixture.
- JavaScript syntax checks passed.

## REMAINS

- Stage 6: final conflict resolution write-back and completion summary.
- Stage 7: explicit already-inspected warning with view/edit/new-inspection flows.
- Stage 8: QR local transport over the same sync engine.
- Stages 9–12: UI cleanup, expanded two-device matrix, full regression, version/build inputs and final documentation/artifacts.
- Real Android build and phone tests remain unavailable here. Git commits cannot be made because no `.git` directory is present.
