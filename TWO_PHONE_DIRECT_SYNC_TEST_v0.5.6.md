# Two-phone direct sync test — v0.5.6

Use a test copy of the current workfile. Before replacing an installed build, export a full `.dtc` work package: signing compatibility is unverified, and uninstalling the app can remove its internal workspace.

## A. Install and launch

1. Build from GitHub Actions artifact **DOLD-TechControl-v0.5.6-debug** and install on both phones. Open DOLD TechControl.
   - Expected: both apps launch; package remains `ee.dold.techcontrol`.
   - If Android rejects an update because of a signature conflict, stop and preserve/export the existing app's work before any uninstall.

## B. Phone A workfile

2. On A, open the current XLSX and continue the existing Kontroll.
   - Expected: registry, current-cycle progress and open defects appear.

## C. Phone B bootstrap by QR

3. Put both phones on the same reachable Wi-Fi/LAN. On A select **Andmed → Seadmete sünkroonimine → NÄITA QR**. On empty B select **SKANEERI QR** in DOLD TechControl.
   - Expected: B shows A's workbook/object/open-defect/progress summary without opening Share, Downloads or a file picker.
4. On B choose **VALMISTA SEE TELEFON ETTE**.
   - Expected: B receives the baseline, current cycle and history. Both phones work on the same database; B retains its own device ID. The raw ID is not visible in the normal UI.

## D–E. Parallel work

5. On A, inspect one previously unchecked cabinet and save one new defect. On B, close one existing defect and enter repairer and work description.
   - Expected: each phone retains its local change after leaving and reopening the screen.

## F. One QR sync

6. On A choose **NÄITA QR**. On B choose **SKANEERI QR** and scan once. Review the preview and press **SÜNKROONI**.
   - Expected: one session shows changes in both directions; no second QR, Share, Downloads or file selection.

## G. Verify union

7. On both phones check that A's inspection/new defect and B's repair are present. Check cycle progress counts the inspected EK once and the repaired defect is closed with its repair details.
   - Expected: both phones retain their own work and include the peer's changes.

## H. Repeat sync

8. Repeat the QR sync.
   - Expected: preview reports zero new changes and no duplicate Kontroll or Puudused rows appear.

## I. Interruption and retry

9. In a separate test, cancel before confirmation or interrupt Wi-Fi during sync. Reconnect and repeat with a new QR if the session expired.
   - Expected: cancellation changes nothing. If the result is reported as unconfirmed, do not recreate changes manually; reconnect and retry. The phones converge without duplicate rows.

## J. Export XLSX

10. Export a timestamped XLSX copy from each phone and open one in LibreOffice Calc.
    - Expected: original source remains untouched; sheets/history/formulas remain; both inspection and repair are represented in the exported workbook.

