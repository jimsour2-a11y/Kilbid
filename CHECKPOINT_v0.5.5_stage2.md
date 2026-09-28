# DOLD TechControl v0.5.5 — Stage 2 checkpoint

## DONE

- Added semantic change capture inside the existing transaction boundary.
- `ADD_KONTROLL`, `UPDATE_KONTROLL`, `ADD_PUUDUS`, `UPDATE_PUUDUS`, `CLOSE_PUUDUS`, and `UPDATE_CABINET_STATUS` operations are prepared from logical entity IDs and changed business fields.
- Each operation stores `opId`, `deviceId`, local sequence, creation time, dbId/epoch, entity type/ID, action, base revision, per-field base versions, and changed field values.
- New local operations update field versions and are appended to the durable journal and applied-op set before the atomic workspace save. The device ID remains device-local.
- Repair closure is journaled against the existing `PuudusID`. It does not create a `Kontrollid` record.
- The transaction rollback restores both workbook and sync metadata if the durable save fails.
- Added regression coverage for add-control/add-defect/close-defect operation shapes, durable journal restoration, and failed-save rollback.

## VERIFIED

- JavaScript syntax checks passed.
- Existing v0.5.4 checks still pass.
- Focused journal test passed.
- Combined regression suite: **25/25 PASS** on the 280-cabinet/250-active fixture.

## REMAINS

- Stage 3: merge operations by field version and surface same-field conflicts.
- Stage 4: apply accepted semantic operations to XLSX by entity ID, preserving workbook structure and current-cycle progress.
- Later stages: package/share UX, duplicate-inspection UX, QR transport, final release metadata/artifacts, and real-device verification.
- No Git repository or Android SDK/device is available for commits/build/device testing in this workspace.
