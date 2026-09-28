# DOLD TechControl v0.5.6.1

Field hotfix for the end-of-sync failure observed during real two-phone QR/LAN testing.

## Fixed

- A deferred host response now consumes its visible `REQUEST_RECEIVED` or `ACK_RECEIVED` event immediately by transitioning to `RESPONSE_QUEUED` under the response lock. Polling cannot respond to the same event twice while the socket worker is waking.
- The deferred host clears its response slot before publishing the next request/acknowledgment event, avoiding a race that could discard a response sent by the WebView.
- QR host flow now performs session-scoped cleanup in `finally` after success, cancellation, protocol error, or unexpected flow failure. A failed/unconfirmed sync no longer leaves the previous listener blocking an immediate new QR.
- Cleanup is tied to the session ID. A repeated start attempt does not stop a different, valid active session.

## Preserved

- The v0.5.5 semantic sync engine, conflict handling, operation journal and idempotency.
- Existing XLSX data model, durable workspace, full `.dtc` handoff and file-based `.dtcs` sync.
- Package ID `ee.dold.techcontrol`.

## Version

- `versionName`: `0.5.6.1`
- `versionCode`: `57`
- GitHub Actions artifact: `DOLD-TechControl-v0.5.6.1-debug.apk`
