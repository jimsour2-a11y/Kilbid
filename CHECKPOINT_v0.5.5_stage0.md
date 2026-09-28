# DOLD TechControl v0.5.5 — Stage 0 checkpoint

## DONE

- Resumed from the saved v0.5.4 project in `techcontrol_v053` and verified the supplied `DOLD_TechControl_Android_v0.5.4_project.zip` is a readable ZIP with the same app version and package baseline.
- Verified source identity: `applicationId ee.dold.techcontrol`, `versionName 0.5.4`, `versionCode 54`.
- Inspected the existing native `WorkspaceStore`: schema 1 remains valid; it atomically stores a complete snapshot (including workbook bytes) under app-private files storage and verifies its checksum.
- Inspected the current `.dtc` path: it packages the workbook and app state and performs the existing user-confirmed full handoff/replacement flow. This remains separate from the new parallel-sync model.
- Inspected the inspection/repair write paths and current-cycle representation: `saveInspection()` updates the linked inspection row and cycle entry; `saveRepair()` updates the existing Puudused row; `cycle.entries` is currently keyed by EK ID and retains row/fingerprint links.
- Ran the existing v0.5.4 suite against the supplied current workbook fixture: **23/23 PASS**. The fixture opened with 280 registered cabinets and 250 active cabinets.

## VERIFIED

- Existing regression baseline passed before v0.5.5 edits.
- v0.5.4 ZIP integrity check passed; its Gradle metadata matches the saved working source version.
- No `.git` repository is present in this workspace, so this checkpoint is the persistent stage record; a Git commit cannot be created here.
- `adb`, `gradle`, and Android SDK environment paths are not available in this workspace. APK/device validation cannot be performed here unless that environment is supplied.

## REMAINS

- Stage 1: add persistent device identity, lineage-scoped sync state, and deterministic stable logical IDs.
- Continue the staged v0.5.5 implementation only after saving/checkpointing each completed stage.
- Physical Android and two-phone verification remains necessary for transport, install, and real-device behavior.
