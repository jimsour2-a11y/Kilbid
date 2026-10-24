#!/usr/bin/env python3
"""Append one non-production Rich Data Picture-in-Cell POC to a copied workbook."""
from __future__ import annotations

import argparse
import hashlib
import os
import posixpath
import re
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

from lxml import etree

EXPECTED_SOURCE_SHA256 = "dc4cdb2beefb4502c9a75441d4042160e8619c33959a932b37daa433f45c4e57"
EXPECTED_PNG_SHA256 = "ff6af60c18f3736f1a480a7d2b31f464f89616ab3fd2d7135bd8198d8373e57f"
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
RICH_REL_NS = "http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel"
RICH_DATA_NS = "http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"
XLRD_NS = "http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"
RICH_EXT_URI = "{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"
XML_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, remove_blank_text=False)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def xml(data: bytes) -> etree._Element:
    return etree.fromstring(data, parser=XML_PARSER)


def xml_bytes(root: etree._Element) -> bytes:
    return etree.tostring(root, encoding="UTF-8", xml_declaration=True, standalone=True)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def resolve_part(source_rels: str, target: str) -> str:
    target = unquote(target.split("#", 1)[0].split("?", 1)[0])
    if target.startswith("/"):
        return str(PurePosixPath(target.lstrip("/")))
    if source_rels == "_rels/.rels":
        parent = PurePosixPath("")
    else:
        source = source_rels.replace("/_rels/", "/").removesuffix(".rels")
        parent = PurePosixPath(source).parent
    return posixpath.normpath(str(parent.joinpath(target)))


def relationship_targets(parts: dict[str, bytes]) -> list[tuple[str, str, str]]:
    found = []
    for name, data in parts.items():
        if not name.endswith(".rels"):
            continue
        root = xml(data)
        for item in root.findall(f"{{{PKG_REL_NS}}}Relationship"):
            mode = item.get("TargetMode", "")
            target = item.get("Target", "")
            if mode == "External" or re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):
                continue
            found.append((name, item.get("Id", ""), resolve_part(name, target)))
    return found


def part_map(archive: zipfile.ZipFile) -> dict[str, bytes]:
    return {info.filename: archive.read(info.filename) for info in archive.infolist() if not info.is_dir()}


def sheet_parts(parts: dict[str, bytes]) -> dict[str, str]:
    wb = xml(parts["xl/workbook.xml"])
    rel_root = xml(parts["xl/_rels/workbook.xml.rels"])
    rels = {r.get("Id"): r.get("Target") for r in rel_root.findall(f"{{{PKG_REL_NS}}}Relationship")}
    result = {}
    for sheet in wb.findall(f"{{{MAIN_NS}}}sheets/{{{MAIN_NS}}}sheet"):
        rid = sheet.get(f"{{{REL_NS}}}id")
        target = rels.get(rid)
        require(bool(target), f"Missing worksheet relationship for {sheet.get('name')}")
        result[sheet.get("name")] = str(PurePosixPath("xl").joinpath(target))
    return result


def cell_xml(sheet: etree._Element, ref: str) -> bytes | None:
    cell = sheet.find(f".//{{{MAIN_NS}}}c[@r='{ref}']")
    return etree.tostring(cell, encoding="UTF-8") if cell is not None else None


def add_inline_cell(row: etree._Element, ref: str, value: str) -> None:
    cell = etree.Element(f"{{{MAIN_NS}}}c", r=ref, t="inlineStr")
    inline = etree.SubElement(cell, f"{{{MAIN_NS}}}is")
    text = etree.SubElement(inline, f"{{{MAIN_NS}}}t")
    text.text = value
    row.append(cell)


def column_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref).group(0)
    value = 0
    for letter in letters:
        value = value * 26 + ord(letter) - 64
    return value


def add_poc_row(sheet_data: etree._Element, image_sha: str, media_path: str) -> None:
    row = sheet_data.find(f"{{{MAIN_NS}}}row[@r='9']")
    if row is None:
        row = etree.Element(f"{{{MAIN_NS}}}row", r="9")
        later = next((item for item in sheet_data if int(item.get("r", "0")) > 9), None)
        sheet_data.insert(sheet_data.index(later), row) if later is not None else sheet_data.append(row)
    else:
        for existing in list(row):
            if existing.tag == f"{{{MAIN_NS}}}c":
                row.remove(existing)

    add_inline_cell(row, "A9", "S1.5-POC-NOT-A-SIGNATURE")
    add_inline_cell(row, "E9", "TEST POC — NOT A SIGNATURE")

    picture = etree.Element(f"{{{MAIN_NS}}}c", r="F9", t="e", vm="3")
    value = etree.SubElement(picture, f"{{{MAIN_NS}}}v")
    value.text = "#VALUE!"
    row.append(picture)
    add_inline_cell(row, "G9", image_sha)
    add_inline_cell(row, "H9", media_path)
    cells = [node for node in row if node.tag == f"{{{MAIN_NS}}}c"]
    extras = [node for node in row if node.tag != f"{{{MAIN_NS}}}c"]
    row[:] = sorted(cells, key=lambda node: column_index(node.get("r", "A1"))) + extras


def next_image_name(parts: dict[str, bytes]) -> str:
    indices = []
    for name in parts:
        match = re.fullmatch(r"xl/media/image(\d+)\.png", name)
        if match:
            indices.append(int(match.group(1)))
    n = max(indices, default=0) + 1
    while f"xl/media/image{n}.png" in parts:
        n += 1
    return f"xl/media/image{n}.png"


def append_rich_data(parts: dict[str, bytes], media_path: str) -> dict[str, bytes]:
    changes: dict[str, bytes] = {}
    rels_path = "xl/richData/_rels/richValueRel.xml.rels"
    rels = xml(parts[rels_path])
    old_rel_ids = {r.get("Id") for r in rels.findall(f"{{{PKG_REL_NS}}}Relationship")}
    n = 1
    while f"rId{n}" in old_rel_ids:
        n += 1
    new_rid = f"rId{n}"
    relation = etree.SubElement(rels, f"{{{PKG_REL_NS}}}Relationship")
    relation.set("Id", new_rid)
    relation.set("Type", f"{REL_NS}/image")
    relation.set("Target", "../media/" + PurePosixPath(media_path).name)
    changes[rels_path] = xml_bytes(rels)

    rich_rels_path = "xl/richData/richValueRel.xml"
    rich_rels = xml(parts[rich_rels_path])
    etree.SubElement(rich_rels, f"{{{RICH_REL_NS}}}rel", {f"{{{REL_NS}}}id": new_rid})
    changes[rich_rels_path] = xml_bytes(rich_rels)

    values_path = "xl/richData/rdrichvalue.xml"
    values = xml(parts[values_path])
    rich_values = values.findall(f"{{{RICH_DATA_NS}}}rv")
    next_index = len(rich_values)
    values.set("count", str(next_index + 1))
    rv = etree.SubElement(values, f"{{{RICH_DATA_NS}}}rv", s="0")
    etree.SubElement(rv, f"{{{RICH_DATA_NS}}}v").text = str(next_index)
    etree.SubElement(rv, f"{{{RICH_DATA_NS}}}v").text = "5"
    changes[values_path] = xml_bytes(values)

    metadata_path = "xl/metadata.xml"
    metadata = xml(parts[metadata_path])
    future = metadata.find(f"{{{MAIN_NS}}}futureMetadata[@name='XLRICHVALUE']")
    value_meta = metadata.find(f"{{{MAIN_NS}}}valueMetadata")
    require(future is not None and value_meta is not None, "XLRICHVALUE metadata is missing")
    existing_future = future.findall(f"{{{MAIN_NS}}}bk")
    existing_values = value_meta.findall(f"{{{MAIN_NS}}}bk")
    metadata_index = len(existing_future)
    require(metadata_index == len(existing_values) == next_index, "Rich Data and metadata indexes are inconsistent before append")
    future.set("count", str(metadata_index + 1))
    bk = etree.SubElement(future, f"{{{MAIN_NS}}}bk")
    ext_list = etree.SubElement(bk, f"{{{MAIN_NS}}}extLst")
    ext = etree.SubElement(ext_list, f"{{{MAIN_NS}}}ext", uri=RICH_EXT_URI)
    etree.SubElement(ext, f"{{{XLRD_NS}}}rvb", i=str(metadata_index))
    value_meta.set("count", str(metadata_index + 1))
    bk = etree.SubElement(value_meta, f"{{{MAIN_NS}}}bk")
    etree.SubElement(bk, f"{{{MAIN_NS}}}rc", t="1", v=str(metadata_index))
    changes[metadata_path] = xml_bytes(metadata)
    return changes


def verify_roundtrip(source_parts: dict[str, bytes], output_parts: dict[str, bytes], media_path: str,
                     png: bytes, modified: set[str]) -> dict:
    source_sheets = sheet_parts(source_parts)
    output_sheets = sheet_parts(output_parts)
    require(source_sheets.keys() == output_sheets.keys(), "Sheet names changed")
    require(set(source_parts).issubset(output_parts), "An original OOXML part was removed")
    require(all(source_parts[p] == output_parts[p] for p in source_parts if p not in modified), "An unrelated OOXML part changed")
    require(output_parts[media_path] == png, "New media part does not match the test PNG")

    sheet_path = output_sheets["Allkirjade pildid"]
    source_sheet = xml(source_parts[sheet_path])
    output_sheet = xml(output_parts[sheet_path])
    source_formulas = {c.get("r"): c.find(f"{{{MAIN_NS}}}f").text for c in source_sheet.findall(f".//{{{MAIN_NS}}}c") if c.find(f"{{{MAIN_NS}}}f") is not None}
    output_formulas = {c.get("r"): c.find(f"{{{MAIN_NS}}}f").text for c in output_sheet.findall(f".//{{{MAIN_NS}}}c") if c.find(f"{{{MAIN_NS}}}f") is not None}
    require(source_formulas == output_formulas, "Existing Allkirjade pildid formulas changed")
    require(cell_xml(source_sheet, "F8") == cell_xml(output_sheet, "F8"), "Reserved F8 changed")
    cell = output_sheet.find(f".//{{{MAIN_NS}}}c[@r='F9']")
    require(cell is not None and cell.get("t") == "e" and cell.get("vm") == "3", "F9 is not a new Rich Data image carrier")
    require(output_sheet.find(f".//{{{MAIN_NS}}}c[@r='A9']/{{{MAIN_NS}}}is/{{{MAIN_NS}}}t").text == "S1.5-POC-NOT-A-SIGNATURE", "POC test marker missing")
    require(output_sheet.find(f".//{{{MAIN_NS}}}c[@r='G9']/{{{MAIN_NS}}}is/{{{MAIN_NS}}}t").text == sha256(png), "G9 PNG SHA-256 is wrong")
    require(output_sheet.find(f".//{{{MAIN_NS}}}c[@r='H9']/{{{MAIN_NS}}}is/{{{MAIN_NS}}}t").text == media_path, "H9 media hint is wrong")

    value_root = xml(output_parts["xl/richData/rdrichvalue.xml"])
    rich_values = value_root.findall(f"{{{RICH_DATA_NS}}}rv")
    require(value_root.get("count") == str(len(rich_values)) == "3", "Rich Data value count/index mismatch")
    require([v.text for v in rich_values[2].findall(f"{{{RICH_DATA_NS}}}v")] == ["2", "5"], "New Rich Data value indexes are wrong")
    source_values = xml(source_parts["xl/richData/rdrichvalue.xml"]).findall(f"{{{RICH_DATA_NS}}}rv")
    require([etree.tostring(rv) for rv in source_values] == [etree.tostring(rv) for rv in rich_values[:2]], "Existing Rich Data image references changed")
    rich_rel_root = xml(output_parts["xl/richData/richValueRel.xml"])
    rich_rel_items = rich_rel_root.findall(f"{{{RICH_REL_NS}}}rel")
    require(len(rich_rel_items) == 3 and rich_rel_items[2].get(f"{{{REL_NS}}}id") == "rId3", "Rich value relationship index mismatch")
    source_rich_rel_items = xml(source_parts["xl/richData/richValueRel.xml"]).findall(f"{{{RICH_REL_NS}}}rel")
    require([etree.tostring(rel) for rel in source_rich_rel_items] == [etree.tostring(rel) for rel in rich_rel_items[:2]], "Existing Rich Data relationships changed")
    rel_root = xml(output_parts["xl/richData/_rels/richValueRel.xml.rels"])
    new_rel = rel_root.find(f"{{{PKG_REL_NS}}}Relationship[@Id='rId3']")
    require(new_rel is not None and new_rel.get("Target") == "../media/" + PurePosixPath(media_path).name, "New media relationship target is wrong")

    metadata = xml(output_parts["xl/metadata.xml"])
    future = metadata.find(f"{{{MAIN_NS}}}futureMetadata[@name='XLRICHVALUE']")
    value_meta = metadata.find(f"{{{MAIN_NS}}}valueMetadata")
    require(future.get("count") == "3" and len(future.findall(f"{{{MAIN_NS}}}bk")) == 3, "futureMetadata count/index mismatch")
    require(value_meta.get("count") == "3" and len(value_meta.findall(f"{{{MAIN_NS}}}bk")) == 3, "valueMetadata count/index mismatch")
    rvb = future.findall(f"{{{MAIN_NS}}}bk")[-1].find(f".//{{{XLRD_NS}}}rvb")
    rc = value_meta.findall(f"{{{MAIN_NS}}}bk")[-1].find(f"{{{MAIN_NS}}}rc")
    require(rvb is not None and rvb.get("i") == "2" and rc is not None and rc.get("v") == "2", "new metadata index is wrong")
    source_metadata = xml(source_parts["xl/metadata.xml"])
    source_future = source_metadata.find(f"{{{MAIN_NS}}}futureMetadata[@name='XLRICHVALUE']")
    source_value_meta = source_metadata.find(f"{{{MAIN_NS}}}valueMetadata")
    require([etree.tostring(bk) for bk in source_future.findall(f"{{{MAIN_NS}}}bk")] == [etree.tostring(bk) for bk in future.findall(f"{{{MAIN_NS}}}bk")[:2]], "Existing futureMetadata indexes changed")
    require([etree.tostring(bk) for bk in source_value_meta.findall(f"{{{MAIN_NS}}}bk")] == [etree.tostring(bk) for bk in value_meta.findall(f"{{{MAIN_NS}}}bk")[:2]], "Existing valueMetadata indexes changed")

    bad = [item for item in relationship_targets(output_parts) if item[2] not in output_parts]
    require(not bad, f"Unresolved relationships remain: {bad[:3]}")
    require(source_parts["xl/worksheets/sheet10.xml"] == output_parts["xl/worksheets/sheet10.xml"], "Allkirjad changed; POC must not create a production signature")
    drawing_parts = [name for name in source_parts if name.startswith("xl/drawings/")]
    require(all(source_parts[name] == output_parts[name] for name in drawing_parts), "Existing drawing/Camera parts changed")
    media_parts = [name for name in source_parts if name.startswith("xl/media/")]
    require(all(source_parts[name] == output_parts[name] for name in media_parts), "Existing image/media parts changed")
    require(source_parts["[Content_Types].xml"] == output_parts["[Content_Types].xml"], "PNG content type was unexpectedly modified")
    return {
        "sheetCount": len(source_sheets),
        "originalPartCount": len(source_parts),
        "outputPartCount": len(output_parts),
        "newMediaPart": media_path,
        "newMediaSha256": sha256(png),
        "drawingPartsPreserved": len(drawing_parts),
        "existingMediaPartsPreserved": len(media_parts),
        "relationshipCount": len(relationship_targets(output_parts)),
        "allRelationshipsResolve": True,
        "existingRichDataPicturesPreserved": True,
        "sheetFormulasPreserved": True,
        "allUnmodifiedPartsByteIdentical": True,
        "allkirjadUnchanged": True,
        "reservedF8Unchanged": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("png", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    require(args.source.resolve() != args.output.resolve(), "Source workbook must not be overwritten")
    source_bytes = args.source.read_bytes()
    require(sha256(source_bytes) == EXPECTED_SOURCE_SHA256, "Supplied R4 source SHA-256 differs from the approved reference")
    png = args.png.read_bytes()
    require(sha256(png) == EXPECTED_PNG_SHA256, "Test PNG differs from the pinned normalized-strokes vector")

    with zipfile.ZipFile(args.source, "r") as source_zip:
        require(source_zip.testzip() is None, "Source XLSX ZIP integrity check failed")
        source_parts = part_map(source_zip)
        names = sheet_parts(source_parts)
        require("Allkirjade pildid" in names and "Allkirjad" in names, "Reference signature sheets are missing")
        media_path = next_image_name(source_parts)
        sheet_path = names["Allkirjade pildid"]
        sheet = xml(source_parts[sheet_path])
        sheet_data = sheet.find(f"{{{MAIN_NS}}}sheetData")
        require(sheet_data is not None, "Allkirjade pildid sheetData is missing")
        add_poc_row(sheet_data, sha256(png), media_path)
        dimension = sheet.find(f"{{{MAIN_NS}}}dimension")
        if dimension is not None:
            ref = dimension.get("ref", "")
            match = re.search(r":([A-Z]+)(\d+)$", ref)
            if match and int(match.group(2)) < 9:
                dimension.set("ref", ref[:match.start(2)] + "9")
        changed = append_rich_data(source_parts, media_path)
        changed[sheet_path] = xml_bytes(sheet)
        changed[media_path] = png

        args.output.parent.mkdir(parents=True, exist_ok=True)
        temp = args.output.with_suffix(args.output.suffix + ".tmp")
        try:
            with zipfile.ZipFile(temp, "w", allowZip64=True) as out:
                out.comment = source_zip.comment
                for info in source_zip.infolist():
                    payload = changed.get(info.filename, source_zip.read(info.filename))
                    out.writestr(info, payload, compress_type=info.compress_type)
                out.writestr(media_path, png, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
            with zipfile.ZipFile(temp, "r") as out_zip:
                require(out_zip.testzip() is None, "Output XLSX ZIP integrity check failed")
                output_parts = part_map(out_zip)
            report = verify_roundtrip(source_parts, output_parts, media_path, png, set(changed))
            require(args.source.read_bytes() == source_bytes, "Original workbook was modified")
            os.replace(temp, args.output)
        except Exception:
            temp.unlink(missing_ok=True)
            raise

    report["sourceSha256"] = sha256(source_bytes)
    report["sourceBytes"] = len(source_bytes)
    report["outputSha256"] = sha256(args.output.read_bytes())
    report["outputBytes"] = args.output.stat().st_size
    report["sourcePath"] = str(args.source)
    report["outputPath"] = str(args.output)
    report["pocMarker"] = "TEST POC — NOT A SIGNATURE"
    print(report)


if __name__ == "__main__":
    main()
