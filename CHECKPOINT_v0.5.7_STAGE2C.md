# DOLD TechControl v0.5.7 — Stage 2C

Date: 2026-11-02
Parent HEAD: fc358b58ab2f8d1dabc73f1ae96c2f0823421e9d
Branch: foundation-v0.5.7

## DONE

- Completed bidirectional Parandus and Signature synchronization.
- Added strict replay integrity for already-applied Parandus and Signature operation IDs.
- Extended proof-to-payload validation across signer, times, device, app, formats, renderer and workbook identity.
- Added v1 and v2 alternate canonical PNG fixtures for independent two-phone evidence.
- Added fail-closed asset corruption, transaction rollback, SignatureID collision and ParandusID collision coverage.

## VERIFIED

Targeted Stage2C two-workspace test: 1/1 PASS.

Independent Kontroll + Signature and Parandus + Signature records created on A and B converged after A → B → A. Repeated A → B and B → A exchanges applied zero new operations and produced duplicates only. Both workspaces had equal permanent-ID sets, statuses, exact PNG hashes, StrokeHashes, PointCounts, ProofHashes, target pointers and no duplicate rows or unresolved conflicts.

A corrupted PNG was rejected before mutation. An injected durable-save failure rolled back workbook, journal and appliedOps. Artificial same-ID/different-content Signature and Parandus packages were rejected without overwrite.

The Java signature core suite invoked by the runner completed 38/38 PASS.

## BLOCKER

Focused existing sync, transport and safety regression remains before the final Stage 2 artifact.

## NEXT

Run focused regressions, create the next free artifact checkpoint and stop before APK/GitHub/physical testing.
