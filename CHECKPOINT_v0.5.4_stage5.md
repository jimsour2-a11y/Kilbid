# DOLD TechControl v0.5.4 — Stage 5 checkpoint

## DONE

- Main person-selection heading now reads `Kes teeb?`.
- Defect grade filter uses `Kõik astmed` and descriptive choices for A, B, C, and D.
- The combined A/B filter is labelled `A — Vahetu oht / B — Kiire`.
- New-defect grade choices and rendered grade descriptions use explicit Estonian meanings.
- No cabinet scoring semantics were changed.

## VERIFIED

- Static text checks found the requested labels and no old standalone A–D filter labels.
- Inline app JavaScript and external controller syntax checks passed.

## REMAINS

- Verify filters and repair task cards through final UI/controller regression tests.
- Continue with Stage 6 safe header and tab-bar layout.
