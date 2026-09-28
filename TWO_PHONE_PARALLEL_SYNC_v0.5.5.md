# DOLD TechControl v0.5.5 — Two-phone parallel sync field guide

## Before starting

- Use the same v0.5.5 application on both phones and the same company workbook lineage.
- Keep a safe copy of the current XLSX before initializing the second phone.
- Initialize Phone B once with a **sync baseline**. Do not use `ANNA TÖÖ ÜLE` for parallel work: that remains the full handoff/replacement flow.
- Keep both phones' internal workspaces. After initialization, do not re-import the source XLSX on either phone.

## Initialize Phone B

1. On Phone A, open the current working XLSX and continue the current Kontroll.
2. Open **Andmed → Seadmete sünkroonimine → VALMISTA TEINE TELEFON**.
3. Send the `.dtcs` baseline through Android Share / Quick Share.
4. On Phone B, choose **Andmed → Võta muudatused vastu**, select the received baseline `.dtcs`, and confirm **VALMISTA ETTE**.
5. On Phone B, verify the cabinet and open-defect totals and continue the same Kontroll cycle.

The baseline copies the workbook and logical sync state. Phone B retains its own installation `deviceId`; both phones share the workbook `dbId`, sync epoch, cycle, and starting logical IDs.

## Work in parallel

- Phone A can continue audit work, for example inspecting EK-052 and EK-053 and recording defects.
- Phone B can work in **Parandused / Tööd**, for example closing existing defects.
- Each successful save is persisted to that phone's internal workbook and semantic change journal.
- Either phone may continue to work while the other one is being used.

## Exchange changes in both directions

1. On Phone A, tap **SAADA MUUDATUSED** and send its `.dtcs` package.
2. On Phone B, tap **VÕTA MUUDATUSED VASTU**, choose that package, inspect the preview, and tap **SÜNKROONI** (or **SÜNKROONI JA LAHENDA VASTUOLUD**).
3. On Phone B, tap **SAADA MUUDATUSED** and send Phone B's `.dtcs` package back.
4. On Phone A, receive that package the same way.
5. Verify both inspections and repair results on both phones. Repeat the exchange after another work period.

The delta package contains semantic operations, not a replacement XLSX. It may include already shared operations; receiving an operation twice is idempotent.

## If a same-field conflict appears

The DOLD **ANDMETE VASTUOLU** dialog shows the field and both values. Choose either:

- **JÄTA SELLE TELEFONI VÄÄRTUS**
- **KASUTA TEISE TELEFONI VÄÄRTUST**

The chosen value is saved to the same logical record and is included in the next delta exchange so the other phone converges to that decision.

## Transport available in this build

Use Android Share / Quick Share to transfer `.dtcs` packages. QR pairing and local-network transfer are not implemented in this source build and have not been tested on phones. Do not scan a cabinet QR as a sync action.

