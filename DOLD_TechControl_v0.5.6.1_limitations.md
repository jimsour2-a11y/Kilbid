# DOLD TechControl v0.5.6.1 — Remaining Verification

- The corrected APK has not been built in this environment. Android SDK, Gradle and `adb` are unavailable; use the updated GitHub Actions workflow to build `DOLD-TechControl-v0.5.6.1-debug.apk`.
- The fix has not yet been installed and retested on the two Android 16 phones. Confirm a full QR/LAN sync reaches `SÜNKROONITUD`, then immediately start a fresh QR after both a successful and an intentionally failed/unconfirmed attempt.
- APK signing-certificate compatibility with the installed v0.5.6 build has not been checked. Do not assume update-over-install until the certificates are compared.

No headless/native regression blocker remains.
