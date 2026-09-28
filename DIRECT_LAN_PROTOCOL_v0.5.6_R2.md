# DOLD TechControl Direct LAN Transport — R2

R2 provides the temporary native transport only. It does not apply the received bytes to XLSX or the synchronization journal. R1's `processSyncPackageBytes(...)` remains the shared semantic sync entry point for a later stage.

## Session and pairing data

The native host binds `ServerSocket` to a discovered, usable private IPv4 address and an OS-assigned free port. The listener is single-use and expires after 180 seconds. Pairing data contains protocol version, IPv4 host, port, random session ID, one-time random token, creation/expiry timestamps, and a SHA-256 fingerprint of the trimmed database ID. The raw database ID and business records are not included.

The token is 32 random bytes encoded as unpadded Base64URL (43 characters). The session ID is 16 random bytes encoded the same way (22 characters). The token is never sent in clear over the socket. The client proves possession with HMAC-SHA-256 over the host's fresh 32-byte challenge and pairing identifiers before the host accepts any payload.

## Wire framing

All integers are network byte order. Text fields are UTF-8 preceded by an unsigned 16-bit byte length and limited to 256 bytes. The fixed magic is `DTCL` (`0x4454434c`). Protocol version is `1`.

1. Host → client `CHALLENGE`: magic, version, type, 32-byte random nonce.
2. Client → host `AUTH`: magic, version, type, session ID, lineage fingerprint, 32-byte HMAC-SHA-256(token, challenge + identifiers).
3. Host → client `AUTH_RESULT`: magic, version, type, status. The host returns success only after checking protocol, session ID, lineage, expiry, and HMAC.
4. Client → host `PAYLOAD`: magic, version, type, signed 32-bit payload length, payload, SHA-256(payload), HMAC-SHA-256(token, challenge + identifiers + length + payload hash).
5. Host → client `RESPONSE`: magic, version, type, status, signed 32-bit response length, response payload, SHA-256(payload), HMAC-SHA-256(token, challenge + status + length + payload hash).

The maximum request or response payload is 1 MiB. The host rejects an oversized declared length before allocating a payload buffer. Non-success responses have empty payloads. Authentication failures return only a generic `AUTH_FAILED` status; malformed, expired, oversized, or integrity-invalid exchanges terminate the temporary session. An authentication failure closes that client socket but leaves the host waiting for a valid peer until success, cancellation, or expiry.

## Native WebView bridge

- `startLanSyncSession(dbId, responseBase64)` → status plus pairing JSON, or `NO_LOCAL_NETWORK`.
- `stopLanSyncSession()` → closes the temporary host listener.
- `getLanSyncSessionStatus()` → waiting/completed/cancelled/expired/error; a completed synthetic request can be retrieved as Base64.
- `startLanSyncClient(pairingJson, expectedDbId, requestBase64)` → async job ID.
- `getLanSyncClientResult(jobId)` → connecting or terminal status; a successful synthetic response is Base64.

The native class transfers opaque bytes and does not depend on `WorkspaceStore`, workbook sheets, current control progress, defects, or semantic merge logic. `MainActivity.onDestroy()` closes the transport, its client executor, and sockets.

## Scope boundary

No QR screen, scanner pairing flow, first-time workbook bootstrap, or business-data merge is part of R2. The temporary payload round-trip has been exercised on a host JVM with loopback sockets. Physical Android/Wi-Fi behavior and a complete Android APK build remain unverified in this environment.
