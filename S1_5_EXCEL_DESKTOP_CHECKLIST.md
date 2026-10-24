# S1.5 Picture-in-Cell POC — Excel Desktop checklist

File: `DOLD_TechControl_allkirjad_prototuup_v0.9.0_S1_5_PICTURE_POC.xlsx`

The added image is deterministic block-letter test geometry marked `TEST POC — NOT A SIGNATURE`. Do not treat it as a person's signature or as production data.

1. Open the POC workbook in Microsoft Excel Desktop and confirm the new image appears in `Allkirjade pildid!F9`.
2. Confirm the adjacent row marker says `TEST POC — NOT A SIGNATURE`; confirm `G9` equals the PNG SHA-256 and `H9` names the new media path.
3. Use the existing selector/drop-down flow and check that the new image can be selected through the prototype's existing dynamic lookup.
4. Check both original `Näidis` Picture-in-Cell images still display.
5. Check the existing Camera/linked-picture object for the control signature.
6. Check the existing Camera/linked-picture object for the repair signature.
7. Save the workbook in Excel, close Excel, and reopen the saved file.
8. Confirm the POC image and both original TEST images still display after reopen.
9. Confirm all four fixed Camera objects remain usable and were not redirected to the POC row.
10. Check both print areas and Print Preview; confirm neither printed sheet is clipped or redirected to the POC.

Record the Excel version and the result for each step. The source workbook is the untouched R4 source; do not save over it.
