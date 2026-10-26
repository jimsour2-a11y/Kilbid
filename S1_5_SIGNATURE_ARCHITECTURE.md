# DOLD TechControl — S1.5 signature architecture decision

S1.5 is an internal pre-S2 checkpoint. It does not accept production signatures, write signature rows into XLSX, or synchronize signature data.

## Kontroll recordVersion

The v0.5.7 schema-1 semantic entity revision is not a safe `Kontroll` recordVersion source. `ensureSyncState()` hydrates entity values from the workbook, but a historical record can have no entity revision at all. When a revision exists, it describes semantic-sync operations over normalized values; it is not a fingerprint of the exact typed fields that the signature snapshot must protect. The old capture adapter could therefore return `UNRESOLVED` for a valid persistent `KontrollID`, or it could not prove that every signed field was unchanged.

The S1.5 source of truth is a per-record map named `signatureVersions`, keyed by the permanent `KontrollID` from `Kontrollid!AA`. Each entry contains an integer `recordVersion`, a SHA-256 `snapshotHash`, and source `KONTROLL_SNAPSHOT_METADATA_V1`. The map is stored in the existing schema-1 durable workspace snapshot and in the workbook's existing `DOLD.TechControl.v1` custom property. No semantic-sync entity, operation, schema, or LAN field was added.

The canonical typed snapshot includes only:

- `KontrollID` (`AA`), cabinet `KilpID` (`B`), inspection date (`A`), inspector (`D`);
- scores `H:R`, preserving blank separately from numeric zero;
- start (`W`), end (`X`), duration (`Y`), and exception reason (`Z`).

Row number, save timestamp, helper columns, derived `Üldhinne` (`S`), signature ID/status, PNG, proof, UI labels, and other display-only data are excluded. Snapshot values are serialized with sorted-key canonical JSON, explicit cell types, UTF-8, then SHA-256.

On reconciliation, a unique valid persistent ID with a supported, complete snapshot receives version 1 only as its first recorded baseline. An unchanged snapshot keeps the same version. Any changed included field advances it by one. A missing or duplicate ID, formula/error cell in a protected field, invalid value, or legacy row without `AA` remains `UNRESOLVED`; no legacy version is invented. Record lookup scans by `KontrollID`; the hydrated row is only a cache hint.

`Parandus` remains unchanged: S1.5 uses a supplied positive `Parandused!L` value when available; otherwise the draft stays `UNRESOLVED`. No new repair-signature workflow was introduced.

## Versioned production PNG renderers

The original profile remains supported for existing drafts and proofs:

`dold-signature-normalized-png-v1;900x300;transparent-rgba;black-opaque;stroke-9px;round-cap;round-join;pad-8pct;map-normalized-x-y;crop-none;png-filter-none-deflate-6-no-metadata`

Its renderer is kept byte-compatible. Validation never relabels its profile or recalculates its stored PNG/hash using a different algorithm.

New captures use:

`dold-signature-fitted-png-v2;900x300;transparent-rgba;black-opaque;stroke-9px;round-cap;round-join;ink-bounds;pad-8pct;preserve-aspect;center;png-filter-none-deflate-6-no-metadata`

The v2 renderer reads integer-millionth normalized points, finds their ink bounds, reserves the 8% outer padding, and applies one uniform scale to fit the bounds in the 900×300 frame. It centers the result and rasterizes opaque black 9-pixel round strokes onto a transparent RGBA image. It never changes or stretches the raw points and does not crop ink. `StrokeHash` and `geometryHash` keep their existing inputs; `PNGHash` covers the exact v2 PNG bytes. The existing proof field stores the renderer profile, so no XLSX column or contract change is needed.

The block-letter test vector is in `tests/signature/s1_5_poc_strokes.json`. On the current JDK, v2 produces 900×300 and SHA-256 `fdbc892694cedd0a9f2130ff7e9c096fed0f11028d3c91c30637a9b0008e42d4`; the v1 renderer remains pinned to `ff6af60c18f3736f1a480a7d2b31f464f89616ab3fd2d7135bd8198d8373e57f`. Byte-identical PNG output across Android/JDK/zlib versions is **not guaranteed**; each `PNGHash` is the hash of the exact final bytes produced by that capture runtime. Physical Android verification remains required.

## Local anti-reuse policy

The approved scope is `LOCAL_KNOWN_DATA`; the algorithm is `dold-exact-reuse/v1`. The validated local draft registry checks exact equality against another `AllkiriID` for any of: nonce, `StrokeHash`, `PNGHash`, or `geometryHash`. Any match is a duplicate. This is not handwriting similarity and does not claim global uniqueness. `UNIQUE` is emitted only after the complete local registry has been read and validated; a corrupt or unreadable registry is `NOT_CHECKED`, never `UNIQUE`. Future printed wording is `Korduskasutuse kontroll: kohalik`.

S1.5 drafts remain local, non-accepted drafts. This rule does not implement production acceptance or cross-device signature checks.

## Production candidate `Allkirjad!T/G` formulas

Both formulas are generated for rows 5:500 and do not extend the workbook's reserved range.

- For `Kontroll`, `T` counts `Allkirjad!C` in `Kontrollid!AA5:AA500`; only count exactly one returns the `MATCH` position. Missing/duplicate IDs and lookup errors return blank.
- For `Parandus`, `T` applies the same rule to `Parandused!A5:A500`.
- `G` returns `Tühistatud` first when stored `F` is revoked. A missing/non-numeric `T` is also cancelled. Otherwise `G` can return `Kehtiv` only when stored `F` is `Kehtiv` and every type-specific protected field still matches; all other results and formula errors fail closed to `Tühistatud`. Production formulas never create `Näidis`.
- Blank parity is tested with `ISBLANK`; nonblank cell types with `TYPE`; strings with `EXACT`; numeric/boolean values with equality. Blank therefore cannot turn into zero.

Mappings are the R4 contract: `Kontrollid A/B/D/H:R/W:X:Y:Z` ↔ `Allkirjad U:V:W/X:AH/AI:AJ:AK:AL`; `Parandused B/C/D/E/F/G/H/L/M/N/O` ↔ `AM:AW`. Generated formulas are each below Excel's 8,192-character formula limit (current G lengths: 5,541 for Kontroll and 3,458 for Parandus). Formula shape and mappings are headless-tested. They have not been evaluated by Microsoft Excel Desktop in this environment.

## Picture-in-Cell test-only POC

The POC is a separate copy of the pinned R4 v0.9.0 workbook. It appends one deterministic block-letter PNG marked `TEST POC — NOT A SIGNATURE` to `Allkirjade pildid!F9`; the reserved `F8` is not used. `G9` carries the PNG SHA-256 and `H9` the media path hint. Rich Data value/metadata indexes and relationships are appended; no existing pointer, signature, or Camera object is redirected or recreated.

The supplied fixture's actual baseline is **82 persistent KontrollID values, 145 Puudused rows, and 143 PuudusID values**, rather than the older expected counts of 81/144/142. `Puudused!S23` and `S25` are empty; 141 existing `T` links and 22 rows marked `UNRESOLVED` / `LEGACY MATCH ONLY` are preserved. Those baseline values are unchanged in the POC.

The POC preserves all 14 sheet names. It adds `xl/media/image7.png`; all 55 original package parts remain. All 43 internal relationship targets resolve. The 10 drawing parts and 10 existing media items remain byte-identical. The four fixed Camera drawing-object names (`DOLD_CheckSignature`, `DOLD_RepairSignature`, and their `_Print` variants), existing drawing anchors, `Allkirjad`, formulas, print setup, defined names, styles, and all unmodified OOXML parts remain preserved. This structural proof does not establish that Excel renders or saves the new Picture-in-Cell correctly; follow `S1_5_EXCEL_DESKTOP_CHECKLIST.md`.

## Existing transport observation

The earlier R5 measurement remains: v0.8.3 direct baseline `.dtcs` is 1,771,056 bytes, 722,480 bytes over the unchanged 1 MiB LAN limit; workbook entry 1,931,335 bytes and state entry 677,967 bytes. S1.5 did not change transport, compression, framing, or the limit.
