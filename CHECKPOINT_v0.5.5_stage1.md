# DOLD TechControl v0.5.5 — Stage 1 checkpoint

## DONE

- Added per-installation `deviceId` stored in app local storage. It is generated once, persists across restarts, is not stored in `TC.sync`, and is not included in the `.dtc` state package.
- Added nested `sync` state while keeping the native WorkspaceStore envelope at schema 1. Sync state carries its own schema, database lineage, shared epoch, stable entity maps, journal/applied-op/conflict collections, and local operation sequence.
- Existing v0.5.4 records receive deterministic `KontrollID` and `PuudusID` values derived from `dbId`, logical record fields, and stable duplicate ordinals. IDs are held in sync metadata, not written into report columns.
- Added stable IDs for cabinet records by permanent EK ID to support future status synchronization.
- Persisted sync state with the internal workspace, embedded app metadata, and `.dtc` full handoff. Full handoff still replaces only after the existing user confirmation; the receiving installation retains its own device ID.
- Expanded defect semantic hydration to include existing repair-related values needed by later operation tracking.
- Transaction refresh now reconciles stable entity IDs before atomically saving the workbook and snapshot. A temporary local row-to-ID bridge preserves an ID when an app edit changes its identifying fields; row numbers are not placed in sync operations.
- Added a two-installation baseline test: same dbId/epoch and stable record IDs after Phone B imports Phone A's baseline; distinct device IDs; no device ID in the package.

## VERIFIED

- `node --check app/src/main/assets/DOLD_TechControl_v0.5.3.js` passed.
- Existing v0.5.4 suite: **23/23 PASS**.
- New two-installation sync-baseline test: **PASS**.
- Combined suite: **24/24 PASS** against the current 280-cabinet/250-active workbook fixture.
- `WorkspaceStore` remains schema 1.

## REMAINS

- Stage 2: journal every meaningful business write atomically with the workbook and add idempotent operation handling.
- Parallel sync merge/apply, conflict UI, package UX, duplicate-inspection UX, QR transport, final version bump, build and physical-device verification remain.
- Git commits are unavailable because this workspace has no `.git` directory; this file is the persistent stage checkpoint.
