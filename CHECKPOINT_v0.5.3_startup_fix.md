# Checkpoint: startup-crash isolation

Stage 1 complete.

The new v0.5.3 `installSystemInsets()` path was removed from `MainActivity.onCreate()`. Startup now uses the same WebView status-bar padding path as the verified v0.5.2 source. No v0.5.3 business logic, package ID, version, XLSX controller, or durable storage code was removed.

Reason: the real device crashes immediately after launch, while v0.5.2 launches on the same Android 16 phone. The new Insets listener was the only native startup path introduced around the WebView and is therefore isolated first. Real-device launch verification remains required.

Stage 2 complete: package/version/manifest/assets/DOM references were checked. No missing JS asset or missing `$()` DOM id was found. Android SDK/Gradle are not installed in this workspace, so compiler verification is delegated to the existing GitHub Actions workflow.

Stage 3 complete: the existing headless regression suite passes all 13 checks after the native startup change.

Stage 4 complete: corrected project ZIPs were generated under both requested names and checked with `unzip -t`. DONE: source saved and build input ready. REMAINS: GitHub Actions build and launch test on the real Android 16 phone.
