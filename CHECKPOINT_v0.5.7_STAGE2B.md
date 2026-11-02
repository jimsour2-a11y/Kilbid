# DOLD TechControl v0.5.7 — Stage 2B

Date: 2026-11-02
Parent HEAD: 5a9b0336addf3c60aa30b446744184562ddde920
Branch: foundation-v0.5.7

## DONE

- Added receiver/apply for immutable `Parandus` operations.
- Added receiver/apply for complete `Signature` evidence and exact assets.
- Added target snapshot and relationship checks before workbook mutation.
- Added monotonic revocation handling: `Tühistatud` cannot become `Kehtiv`.
- Added collision rejection for reused ParandusID or SignatureID with different content.
- Receiver updates existing production sheets, Rich Data and target pointers inside the existing workbook transaction.

## VERIFIED

Targeted two-workspace A → B test: 1/1 PASS.

The receiver reproduced one Parandus and three signature records (active Kontroll, revoked Kontroll history, active Parandus) with equal permanent IDs, payloads, PNG hashes, StrokeHashes, point counts, proof hashes and pointers. No conflict was reported.

The Java signature core suite invoked by the runner completed 38/38 PASS.

## BLOCKER

Bidirectional replay, collision and focused legacy sync regression remain for Stage 2C.

## NEXT

Stage 2C — A → B → A convergence, idempotency, collision rejection and regression.
