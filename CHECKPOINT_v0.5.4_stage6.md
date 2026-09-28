# DOLD TechControl v0.5.4 — Stage 6 checkpoint

## DONE

- Added WebView CSS `env(safe-area-inset-top)` padding to the header so brand/title/counter content moves below the browser-reported safe area.
- Made the top tabs a non-shrinking horizontally scrollable row with touch scrolling; this keeps Seaded/Andmed reachable on narrow screens.
- Kept the existing verified Android 16 startup code unchanged; no WindowInsets listener or early native initialization was added.
- Visible page title/header/footer version text is now v0.5.4.

## VERIFIED

- Static inspection confirms the CSS uses the system safe-area variable and horizontal scrolling, and MainActivity startup code is unchanged.
- Inline app JavaScript and controller syntax checks pass.

## REMAINS

- Status bar overlap and tab reachability require final visual confirmation on the real Android 16 phone; this workspace has no emulator/device.
- Continue with Stage 7: rename the XLSX tab to Andmed.
