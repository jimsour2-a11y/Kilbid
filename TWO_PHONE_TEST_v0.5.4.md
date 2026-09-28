# DOLD TechControl v0.5.4 — two-phone field test

Use one phone at a time as the owner of the work. A `.dtc` package replaces the selected phone's working copy only after the receiver confirms the comparison. Do not make separate edits to the same workbook on both phones between handoff and return.

Before installing v0.5.4 over the currently installed app, try the normal Android update. If Android reports a signature mismatch and requires an uninstall, first open the old app and export its timestamped XLSX. Keep that file safe, then reinstall v0.5.4 and import the XLSX. This build's signing certificate has not been compared with the installed APK certificate.

## Phone A: hand off the current work

1. Open DOLD TechControl and continue the saved working file.
2. Check that the workbook name, `Kontroll` progress, and open `Puudused` count are expected.
3. Open **Andmed** and tap **ANNA TÖÖ ÜLE**.
4. In the Android share sheet, choose Quick Share, Bluetooth, or another trusted way to send the `.dtc` file to Phone B.
5. If the chosen app saves a file instead of sending it directly, remember the saved location.

## Phone B: receive and do repair work

1. Open DOLD TechControl **v0.5.4** and go to **Andmed → VÕTA TÖÖ VASTU**.
2. Choose the received file ending in `.dtc`.
3. Compare the `TELEFONIS` and `SAABUV PAKETT` summaries. Confirm the database and progress are the expected ones, then tap **VÕTA TÖÖ VASTU**. If the comparison is unexpected, tap **TÜHISTA**; the phone's saved copy will remain.
4. Return to **Avaleht**, choose the electrician, then open **PARANDUSED / TÖÖD**.
5. Open one existing defect, record the repairer and work performed, and save it as completed.
6. Fully close the app, reopen it, choose **JÄTKA VIIMASE TÖÖFAILIGA**, and verify that the repair remains closed and the inspection progress is unchanged.
7. Open **Andmed → ANNA TÖÖ ÜLE** and send the updated `.dtc` package back to Phone A.

## Phone A: receive the returned work

1. Choose **Andmed → VÕTA TÖÖ VASTU** and select the returned `.dtc` package.
2. Confirm the comparison shows the returned package as newer and that its open-defect count reflects the completed repair.
3. Accept the package. Check that the repaired defect is closed, current `Kontroll` progress is retained, and historical `Kontrollid` data remains present.

## What to record

- Whether each phone launched and reopened the last saved file.
- The `Kontroll` count and open-defect count before handoff, on Phone B after receipt, and on Phone A after return.
- Whether the Android share sheet offered the intended transfer target and whether the file chooser found the received `.dtc`.
- Any delay, warning, or unexpected comparison text.

The `.dtc` file is a ZIP-based DOLD package containing the working XLSX, its base workbook, and app state, with SHA-256 integrity checks. The package is not encrypted; use a transfer destination approved for this company data.
