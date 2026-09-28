# DOLD TechControl v0.5.4 — Stage 3 checkpoint

## DONE

- New Kontroll stores the real local date and time (including seconds) without converting the display to a fabricated midnight.
- Reconstructed cycles prefer the earliest real `Kontrollid!W` start timestamp. When no valid W value exists, the cycle stores only the earliest date.
- Cycle display now derives record-based start labels from W and suppresses an old midnight placeholder when the historic records contain no time.

## VERIFIED

- The supplied workbook contains real W times; earliest sampled current-cycle start was `24.09.2026 16:30:25`.
- Focused tests passed: import/count baseline and test 17 (recorded W time, date-only fallback, and local manual start).
- JavaScript syntax checks passed.

## REMAINS

- Full regression run remains scheduled for Stage 12.
- Continue with Stage 4 area auto-context.
