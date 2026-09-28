# DOLD TechControl v0.5.4 — Stage 4 checkpoint

## DONE

- Opening a cabinet through QR, search-result selection, or cabinet-list selection now sets the Ala/osakond filter to that cabinet's area before showing the inspection screen.
- The cabinet list and area progress statistics refresh immediately. Typing or editing search text does not change the selected area.
- Manual area selection remains unchanged.

## VERIFIED

- Controller syntax check passed.
- Change is isolated to the existing `openCab` selection path; the search and filter implementation is untouched.

## REMAINS

- Add focused open-by-selection and search-typing assertions in the final regression stage.
- Continue with Stage 5 Estonian wording and grade labels.
