# DOLD TechControl v0.5.6

Package: `ee.dold.techcontrol`  
Version: `0.5.6` (`versionCode 56`)

- DOLD `.dtc` and `.dtcs` packages are routed by their `manifest.json` format, including files renamed to `.dtc.zip` or `.dtcs.zip`. Ordinary XLSX import and file-based package transfer remain available.
- Added direct phone pairing through the app's QR scanner and a temporary authenticated LAN session.
- An empty second phone can receive the working baseline. It keeps its own installation `deviceId` while joining the same database lineage.
- One QR pairing session supports bidirectional inspection and repair synchronization through the existing semantic operation engine, with preview, stable record IDs, idempotency and field conflict resolution.
- Added failure reporting and recovery checks for interrupted exchanges, failed local saves, lost acknowledgements and safe retry.
- Kept `.dtcs` package sync as fallback and `.dtc` full work handoff as a separate ownership-transfer workflow.

Automated regression suites pass; the APK and direct flow have not been tested on physical Android phones. See the test report and limitations document.

