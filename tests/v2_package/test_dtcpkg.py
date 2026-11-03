import io
import json
import pathlib
import unittest
import zipfile

from dtcpkg import PackageError, create_work_package, read_package

HERE = pathlib.Path(__file__).resolve().parent
DATASET = "TEST-A1-ISOLATED-20261103"
MANIFEST = dict(contractVersion="0.1-test", schemaVersion=1, module="Kilbid", environment="TEST",
                datasetId=DATASET, packageId="TEST-A1-PACKAGE-001", createdAtUtc="2026-11-03T12:00:00Z",
                senderDeviceId="TEST-A1-GENERATOR", senderPersonId=None)
PAYLOAD = dict(snapshotId="TEST-A1-SNAPSHOT-001", baseSnapshotId=None, fullSnapshot=True,
               scope={"areas": ["TEST-A1-AREA"], "taskTypes": ["RECHECK"]},
               cabinets=[dict(kilpId="TEST-A1-KILP-001", name="TEST cabinet", area="TEST-A1-AREA",
                              location="TEST bench", equipment="TEST motor", usageStatus="ACTIVE", revision=1)],
               lastInspections=[dict(kontrollId="TEST-A1-KONTROLL-001", kilpId="TEST-A1-KILP-001",
                                     dateUtc="2026-11-01T08:00:00Z", inspectorPersonId="TEST-A1-PERSON-001",
                                     scores={"A": 3}, remarks="Artificial inspection", revision=1)],
               openDefects=[dict(puudusId="TEST-A1-PUUDUS-001", kontrollId="TEST-A1-KONTROLL-001",
                                 kilpId="TEST-A1-KILP-001", severity="B", description="Artificial loose terminal",
                                 status="OPEN", revision=1)],
               repairs=[dict(parandusId="TEST-A1-PARANDUS-001", puudusId="TEST-A1-PUUDUS-001",
                             dateUtc="2026-11-02T08:00:00Z", actorPersonId="TEST-A1-PERSON-002",
                             workDone="Artificial tightening", status="DONE")],
               tasks=[dict(taskId="TEST-A1-TASK-001", type="RECHECK", kilpId="TEST-A1-KILP-001",
                           kontrollId="TEST-A1-KONTROLL-001", puudusId="TEST-A1-PUUDUS-001",
                           parandusId="TEST-A1-PARANDUS-001")])


def rewrite(raw, modify=None, extra=None):
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        entries = [(i.filename, z.read(i)) for i in z.infolist()]
    if modify:
        entries = [(p, modify(p, d)) for p, d in entries]
    entries.extend(extra or [])
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p, d in entries:
            z.writestr(p, d)
    return out.getvalue()


def edit_manifest(raw, **changes):
    def mutate(path, data):
        if path != "manifest.json":
            return data
        value = json.loads(data)
        value.update(changes)
        return json.dumps(value).encode()
    return rewrite(raw, mutate)


class PackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = create_work_package(MANIFEST, PAYLOAD)

    def rejected(self, raw):
        with self.assertRaises(PackageError):
            read_package(raw, DATASET)

    def test_work_roundtrip_and_links(self):
        manifest, payload, archive_hash = read_package(self.raw, DATASET)
        self.assertEqual(manifest["packageType"], "WORK_PACKAGE")
        self.assertEqual(payload, PAYLOAD)
        self.assertEqual(len(archive_hash), 64)
        self.assertEqual(payload["tasks"][0]["parandusId"], payload["repairs"][0]["parandusId"])

    def test_corrupt_archive(self):
        self.rejected(self.raw[:len(self.raw)//2])

    def test_crc_corruption(self):
        raw = bytearray(self.raw)
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            info = z.getinfo("payload.json")
        # Flip a byte of compressed payload, not the unused local-header CRC.
        offset = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
        raw[offset + info.compress_size // 2] ^= 1
        self.rejected(bytes(raw))

    def test_environment(self):
        self.rejected(edit_manifest(self.raw, environment="PRODUCTION"))

    def test_dataset(self):
        self.rejected(edit_manifest(self.raw, datasetId="TEST-OTHER"))

    def test_contract(self):
        self.rejected(edit_manifest(self.raw, contractVersion="0.2-test"))
        self.rejected(edit_manifest(self.raw, schemaVersion=2))

    def test_payload_hash(self):
        self.rejected(rewrite(self.raw, lambda p, d: d + b" " if p == "payload.json" else d))

    def test_forbidden_paths(self):
        for path in ("../escape", "/absolute", "a//b", "a/./b", "C:/drive", "a\\b"):
            with self.subTest(path=path):
                self.rejected(rewrite(self.raw, extra=[(path, b"bad")]))

    def test_duplicate_entry(self):
        self.rejected(rewrite(self.raw, extra=[("payload.json", b"duplicate")]))

    def test_unlisted_and_symlink(self):
        self.rejected(rewrite(self.raw, extra=[("unlisted.bin", b"bad")]))
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as z:
            z.writestr("manifest.json", b"{}")
            z.writestr("payload.json", b"{}")
            link = zipfile.ZipInfo("link")
            link.create_system = 3
            link.external_attr = (0o120777 << 16)
            z.writestr(link, b"payload.json")
        self.rejected(output.getvalue())

    def test_limits(self):
        self.rejected(self.raw + b"\0" * (50 * 1024 * 1024))
        self.rejected(rewrite(self.raw, extra=[(f"x/{n}", b"") for n in range(1000)]))
        self.rejected(rewrite(self.raw, lambda p, d: b" " * (4 * 1024 * 1024 + 1) if p == "payload.json" else d))
        self.rejected(rewrite(self.raw, extra=[("asset.bin", b"0" * (20 * 1024 * 1024 + 1))]))

    def test_broken_link(self):
        changed = json.loads(json.dumps(PAYLOAD))
        changed["tasks"][0]["parandusId"] = "TEST-A1-NONEXISTENT"
        with self.assertRaises(PackageError):
            create_work_package(MANIFEST, changed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
