"""Isolated TEST 0.1 .dtcpkg reference codec; no v1 or database integration."""

import hashlib
import io
import json
import re
import stat
import zipfile
from datetime import datetime, timezone
from pathlib import PurePosixPath

MAX_ARCHIVE = 50 * 1024 * 1024
MAX_JSON = 4 * 1024 * 1024
MAX_ASSET = 20 * 1024 * 1024
MAX_ENTRIES = 1000
SHA = re.compile(r"[0-9a-f]{64}\Z")


class PackageError(ValueError):
    pass


def _require(ok, message):
    if not ok:
        raise PackageError(message)


def _path(path):
    _require(isinstance(path, str) and path != "" and "\\" not in path and "\x00" not in path, "invalid ZIP path")
    parts = path.split("/")
    _require(not path.startswith("/") and not re.match(r"^[A-Za-z]:", path)
             and all(p not in ("", ".", "..") for p in parts)
             and str(PurePosixPath(path)) == path, "forbidden ZIP path")


def _json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            _require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique)
    except (UnicodeError, ValueError) as e:
        raise PackageError("invalid UTF-8 JSON") from e


def _iso(value):
    _require(isinstance(value, str) and value.endswith("Z"), "UTC timestamp required")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        raise PackageError("invalid timestamp") from e


def _nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def _validate_work(payload):
    _require(isinstance(payload, dict), "payload object required")
    for key in ("snapshotId", "baseSnapshotId", "fullSnapshot", "scope", "cabinets",
                "lastInspections", "openDefects", "repairs", "tasks"):
        _require(key in payload, "missing payload field: " + key)
    _require(_nonempty(payload["snapshotId"]) and isinstance(payload["fullSnapshot"], bool), "invalid snapshot")
    _require(payload["baseSnapshotId"] is None if payload["fullSnapshot"] else _nonempty(payload["baseSnapshotId"]), "invalid baseSnapshotId")
    _require(isinstance(payload["scope"], dict), "invalid scope")
    for key in ("cabinets", "lastInspections", "openDefects", "repairs", "tasks"):
        _require(isinstance(payload[key], list), "invalid " + key)
    cabinets = set()
    inspections = set()
    defects = set()
    repairs = set()
    for c in payload["cabinets"]:
        _require(isinstance(c, dict) and all(_nonempty(c.get(k)) for k in ("kilpId", "name", "area", "location", "equipment", "usageStatus")) and "revision" in c, "invalid cabinet")
        _require(c["kilpId"] not in cabinets, "duplicate cabinet")
        cabinets.add(c["kilpId"])
    for i in payload["lastInspections"]:
        _require(isinstance(i, dict) and all(_nonempty(i.get(k)) for k in ("kontrollId", "kilpId", "inspectorPersonId")) and "scores" in i and "remarks" in i and "revision" in i, "invalid inspection")
        _iso(i.get("dateUtc"))
        _require(i["kilpId"] in cabinets and i["kontrollId"] not in inspections, "inspection link")
        inspections.add(i["kontrollId"])
    for d in payload["openDefects"]:
        _require(isinstance(d, dict) and all(_nonempty(d.get(k)) for k in ("puudusId", "kontrollId", "kilpId", "description", "status")) and d.get("severity") in ("A", "B", "C", "D") and "revision" in d, "invalid defect")
        _require(d["kilpId"] in cabinets and d["kontrollId"] in inspections and d["puudusId"] not in defects, "defect link")
        defects.add(d["puudusId"])
    for r in payload["repairs"]:
        _require(isinstance(r, dict) and all(_nonempty(r.get(k)) for k in ("parandusId", "puudusId", "actorPersonId", "workDone", "status")), "invalid repair")
        _iso(r.get("dateUtc"))
        _require(r["puudusId"] in defects and r["parandusId"] not in repairs, "repair link")
        repairs.add(r["parandusId"])
    for t in payload["tasks"]:
        _require(isinstance(t, dict) and _nonempty(t.get("taskId")) and t.get("type") in ("INSPECTION", "REPAIR", "RECHECK"), "invalid task")
        _require(t.get("kilpId") in cabinets, "task cabinet link")
        if t["type"] == "RECHECK":
            _require(t.get("kontrollId") in inspections and t.get("puudusId") in defects and t.get("parandusId") in repairs, "recheck link")


def read_package(raw, expected_dataset_id):
    """Validate all bytes before returning data; never mutates durable state."""
    _require(isinstance(raw, bytes) and len(raw) <= MAX_ARCHIVE, "archive limit")
    _require(_nonempty(expected_dataset_id), "expected dataset required")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            _require(len(infos) <= MAX_ENTRIES, "entry count limit")
            names = set()
            for info in infos:
                _path(info.filename)
                _require(info.filename not in names, "duplicate ZIP entry")
                names.add(info.filename)
                _require(not info.is_dir() and not stat.S_ISLNK(info.external_attr >> 16), "directory or symlink")
                _require(info.flag_bits & 1 == 0 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "unsupported ZIP entry")
                limit = MAX_JSON if info.filename.endswith(".json") else MAX_ASSET
                _require(info.file_size <= limit, "entry size limit")
            _require({"manifest.json", "payload.json"} <= names, "missing mandatory entry")
            def limited(name):
                limit = MAX_JSON if name.endswith(".json") else MAX_ASSET
                with archive.open(name) as stream:
                    data = stream.read(limit + 1)
                    _require(len(data) <= limit and not stream.read(1), "inflated entry limit")
                    return data
            manifest = _json(limited("manifest.json"))
            _require(isinstance(manifest, dict), "manifest object required")
            # Guard compatibility before parsing business data.
            _require(manifest.get("schemaVersion") == 1 and type(manifest.get("schemaVersion")) is int
                     and manifest.get("contractVersion") == "0.1-test" and manifest.get("module") == "Kilbid", "unsupported contract")
            _require(manifest.get("environment") == "TEST", "non-TEST package")
            _require(manifest.get("datasetId") == expected_dataset_id, "dataset mismatch")
            for key in ("packageId", "senderDeviceId"):
                _require(_nonempty(manifest.get(key)), "missing " + key)
            _require(manifest.get("senderPersonId") is None or _nonempty(manifest.get("senderPersonId")), "invalid senderPersonId")
            _iso(manifest.get("createdAtUtc"))
            _require(manifest.get("packageType") in ("WORK_PACKAGE", "CHANGE_PACKAGE", "ACK_PACKAGE") and manifest.get("payloadPath") == "payload.json", "invalid manifest type/path")
            files = manifest.get("files")
            _require(isinstance(files, list), "files list required")
            paths = set()
            for record in files:
                _require(isinstance(record, dict), "invalid file record")
                path = record.get("path")
                _path(path)
                _require(path not in paths and path != "manifest.json" and path in names, "file inventory mismatch")
                paths.add(path)
                data = limited(path)
                _require(type(record.get("byteLength")) is int and record["byteLength"] == len(data)
                         and isinstance(record.get("sha256"), str) and SHA.fullmatch(record["sha256"])
                         and record["sha256"] == hashlib.sha256(data).hexdigest(), "file size/hash mismatch")
            _require(paths == names - {"manifest.json"} and "payload.json" in paths, "unlisted entry")
            payload = _json(limited("payload.json"))
            if manifest["packageType"] == "WORK_PACKAGE":
                _validate_work(payload)
            return manifest, payload, hashlib.sha256(raw).hexdigest()
    except (zipfile.BadZipFile, EOFError, OSError, RuntimeError) as e:
        raise PackageError("damaged ZIP") from e


def create_work_package(manifest_fields, payload, assets=None):
    assets = dict(assets or {})
    _require("manifest.json" not in assets and "payload.json" not in assets, "reserved asset name")
    for path in assets:
        _path(path)
        _require(isinstance(assets[path], bytes), "binary asset required")
    payload_bytes = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    entries = {"payload.json": payload_bytes, **assets}
    files = [{"path": path, "byteLength": len(data), "sha256": hashlib.sha256(data).hexdigest()}
             for path, data in sorted(entries.items())]
    manifest = {**manifest_fields, "packageType": "WORK_PACKAGE", "payloadPath": "payload.json", "files": files}
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", manifest_bytes)
        for path, data in sorted(entries.items()):
            archive.writestr(path, data)
    raw = output.getvalue()
    read_package(raw, manifest_fields["datasetId"])
    return raw
