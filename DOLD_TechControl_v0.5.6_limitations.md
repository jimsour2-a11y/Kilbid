# DOLD TechControl v0.5.6 — Limitations

- **APK not built in this environment.** Android SDK, Gradle and adb are unavailable. The GitHub Actions workflow is prepared to build the debug APK.
- **Android 16 not tested physically.** Startup, runtime permissions, screen insets and lifecycle behavior still need an on-device check.
- **Real camera QR flow not tested.** Automated tests cover the pairing and scanner bridge; camera focus, permission prompts and scan distance require a phone.
- **Real two-phone Wi-Fi/LAN not tested.** Both phones need a reachable local IPv4 network. Router guest isolation, client isolation, firewall settings or VPN routing can block the connection.
- **Signing and update compatibility not verified.** The project uses the normal debug build. No certificate comparison was made against an installed v0.5.5 APK; Android may require a planned data-preserving migration before replacing an install.
- **One QR session uses two TCP exchanges.** A single scan starts the session; the protocol then makes separate exchanges for preview/apply/acknowledgement. This is intentional and tested headlessly/with loopback sockets, not on phones.
- **A lost final acknowledgement can leave an uncertain result.** A phone may already have durably saved its side. It reports the result as unconfirmed; reconnect and retry. Idempotency prevents duplicate application, but there is no cross-device rollback after an independent durable commit.
- **Transport is authenticated, not encrypted.** The app uses a one-time token and integrity/authentication checks but does not add TLS. Use a trusted local network.
- **LAN payload limit is 1 MiB.** Larger workbooks should use the existing `.dtcs` package fallback.

Status: **source release ready for GitHub build and physical acceptance test**, not production-ready.

