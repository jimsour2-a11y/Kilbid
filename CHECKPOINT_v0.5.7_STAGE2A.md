# DOLD TechControl v0.5.7 — Stage 2A

Date: 2026-11-02
Parent HEAD: 0385f588bc67c65f118a36df3864dbbb75c28b93
Branch: foundation-v0.5.7

## DONE

- Added immutable semantic representations for `Parandus` and `Signature`.
- Added `.dtcs` package version 2.
- Added exact signature assets:
  - `signatures/<SignatureID>/signature.png`
  - `signatures/<SignatureID>/strokes.json`
- Added package, operation, payload, proof, hash, PNG and strokes validation.
- Existing production signatures and repairs are journaled on the first v2 persistence.
- Old APKs accept only package version 1 and therefore reject v2 before applying operations.

## VERIFIED

Targeted Stage2A package test: 1/1 PASS.

The generated package contained a Kontroll signature, a Parandus signature and a revoked signature with original permanent IDs, exact PNG bytes, exact raw points, proof, hashes and status. A package relabelled to version 1 was rejected.

The Java signature core suite invoked by the runner completed 38/38 PASS.

## BLOCKER

Receiver/apply is not implemented at this checkpoint.

## NEXT

Stage 2B — receiver/apply and A → B equality.
