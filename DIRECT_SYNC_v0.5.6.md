# Direct phone synchronization — v0.5.6

## First-time setup

Both phones need access to the same reachable local Wi-Fi/LAN. Phone A opens the existing workfile and chooses **Andmed → Seadmete sünkroonimine → NÄITA QR**. Phone B opens DOLD TechControl, chooses **SKANEERI QR**, and scans Phone A's screen. If B has no work database, it shows the source workbook summary and asks the user to confirm **VALMISTA SEE TELEFON ETTE**.

The baseline transfers the workbook and the required current-cycle/synchronization state. Phone B retains or generates its own `deviceId`; it receives the same `dbId` and sync epoch. The device ID is internal and is not shown in the normal UI.

## Normal direct sync

Phone A starts **NÄITA QR**; Phone B scans once. The apps exchange semantic operation packages, show a preview, and use the existing operation merge/conflict engine. The user confirms **SÜNKROONI**. Inspection, defect, repair and status changes are exchanged in both directions. Repeated delivery is idempotent.

One user QR session uses two short authenticated TCP exchanges for preview/apply/acknowledgement. It does not use a persistent single socket and does not require a second scan. If a commit succeeds but its final acknowledgement is lost, the app reports an unconfirmed result; reconnect and retry so the journals can converge safely.

## Pairing and transport

The QR contains connection/session information only: protocol, local IPv4 address, temporary port, random session ID, one-time token, expiry and a database-lineage fingerprint. It does not contain workbook rows, employee data, inspections, defects or the operation journal.

The native transport opens a one-shot listener only for a session, uses a 256-bit random token and a 128-bit session ID, selects a free local port, and expires the session after three minutes. Frames are authenticated and integrity checked; payloads are limited to 1 MiB. The application does not add TLS encryption, so use a trusted local network. Network isolation or firewall rules may prevent the phones from reaching each other.

## Fallbacks

- **Package sync (`.dtcs`)** exchanges parallel-work changes through Android Share/Quick Share or a file picker when direct LAN is unavailable.
- **Full work handoff (`.dtc`)** remains a separate transfer in which the receiving phone takes over the working copy. It is not the parallel merge workflow.

