# DOLD TechControl v0.5.5 — Parallel sync format

## Identity and lineage

- `deviceId`: generated once per app installation and kept in that installation's local storage. It is not copied in a sync baseline or full `.dtc` handoff. Uninstalling may generate a new value.
- `dbId`: existing DOLD workspace/database lineage ID. Deltas are rejected unless it matches the active workspace.
- `epoch`: identifies the sync starting lineage. Deltas from another epoch are rejected even if the `dbId` matches.
- Device names or electrician names are business fields, never device identity.

## Stable logical IDs

App-managed entities use permanent IDs at least for `KontrollID` and `PuudusID`; cabinet status entities use the permanent EK ID as their logical key. Before a row has an app ID, migration derives a deterministic ID from `dbId`, entity type, and a canonical record identity/fingerprint. The same baseline content and lineage therefore produce the same starting IDs on both devices. After assignment, field edits do not change the entity ID. Excel row numbers are local lookup hints only and are never sync identity.

## Operation record

Each business operation is JSON with these required fields:

| Field | Meaning |
|---|---|
| `schema` | Operation schema, currently `1` |
| `opId` | Unique operation ID, formed from installation `deviceId` and its local sequence |
| `deviceId`, `localSequence` | Origin installation and monotonic local ordering |
| `createdAt` | Operation creation timestamp |
| `dbId`, `epoch` | Database lineage and sync baseline |
| `entityType`, `entityId` | Logical `Kontroll`, `Puudus`, or `Cabinet` record |
| `action` | For example `ADD_KONTROLL`, `UPDATE_KONTROLL`, `ADD_PUUDUS`, `UPDATE_PUUDUS`, `CLOSE_PUUDUS`, `UPDATE_CABINET_STATUS` |
| `baseRevision` | Entity revision observed when the operation was created |
| `baseFieldVersions` | Per-field operation versions from which the change was made |
| `changedFields` | Semantic field names and values; no cell addresses or row numbers |

Conflict-resolution operations may also include `resolvesFieldVersions[field]`, listing both competing field versions settled by the user's choice. This lets the choice propagate and prevents the reciprocal sync from raising the same conflict again.

## Merge rules

For each changed field:

1. If the incoming value already equals the local value, treat it as already satisfied.
2. If the local field version equals the operation's base field version, apply it.
3. If the operation explicitly resolves the local field version, apply the chosen value.
4. Otherwise, retain the local value and create an unresolved same-field conflict. The user must choose local or incoming value in the DOLD dialog.

Different fields merge independently. A repair can close a Puudus while a different operation changes its owner. Timestamps alone do not select a winner.

## Package layout

All packages are ZIP archives named with `.dtcs` and have a `manifest.json` containing `format: DOLD-TECHCONTROL-SYNC-PACKAGE`, `version: 1`, `mode`, `dbId`, `epoch`, `senderDeviceId`, creation time, app version, and integrity metadata.

### Baseline (`mode: baseline`)

- `manifest.json`
- `workbook.xlsx`
- `state.json`

The manifest records byte length and SHA-256 for the workbook and state. The copied state includes sync entities, IDs, cycle, and journal state; it does not copy the sender's `deviceId` or camera-presence state. Baselines are only for initializing Phone B before parallel work.

### Delta (`mode: delta`)

- `manifest.json`
- `operations.json`

The manifest records the operation-array byte length, count, and SHA-256. No XLSX is included. Current implementation places the persisted journal in this file; already shared operations can reappear in later packages and are ignored through `appliedOps` idempotency.

Both import paths also check ZIP CRCs. A corrupt package, wrong `dbId`, or wrong epoch is rejected before the local workbook is modified. Received operations and workbook edits are persisted in one workspace transaction; a persistence failure restores the prior workbook and sync snapshot.

## Workbook apply

Apply operations by `KontrollID`, `PuudusID`, or EK status key, then resolve the current row locally. New records append to the named `Kontrollid` or `Puudused` sheet. Updates and repair closure change the existing logical record. Inspection date, inspector, scores H:R, start W, end X, numeric duration Y, and exception Z are mapped semantically. Repair does not create a Kontrollid row. Existing workbook parts, formulas, styles, history, and unknown sheets remain in the workbook archive.

## Relationship to `.dtc`

`.dtc` is the existing whole-workbook work handoff/replacement package. `.dtcs` is the separate parallel-work synchronization package: baseline initializes a second device, and deltas merge logical operations. The two formats and their UI labels remain separate. Neither device ID is copied to the other installation.

## Transport status

v0.5.5 source currently implements Android Share / Quick Share file transfer for `.dtcs`. QR pairing/local transfer is deferred; no QR payload or unauthenticated network endpoint is part of this format.

