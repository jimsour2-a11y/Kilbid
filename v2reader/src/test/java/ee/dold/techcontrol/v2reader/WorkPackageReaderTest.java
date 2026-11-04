package ee.dold.techcontrol.v2reader;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real TEST fixture from A1 and deliberately damaged synthetic variants. */
public class WorkPackageReaderTest {
    private static final String DATASET = "TEST-A1-ISOLATED-20261103";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private byte[] fixture() throws Exception {
        try (InputStream in = getClass().getResourceAsStream("/TEST_A1_WORK_PACKAGE.dtcpkg")) {
            assertNotNull("A1 fixture must be on test classpath", in);
            return in.readAllBytes();
        }
    }

    private static Map<String, byte[]> unpack(byte[] raw) throws Exception {
        Map<String, byte[]> items = new LinkedHashMap<>();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(raw), StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                items.put(entry.getName(), zip.readAllBytes());
            }
        }
        return items;
    }

    private static byte[] zip(Map<String, byte[]> items) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
            for (Map.Entry<String, byte[]> item : items.entrySet()) {
                zip.putNextEntry(new ZipEntry(item.getKey()));
                zip.write(item.getValue());
                zip.closeEntry();
            }
        }
        return out.toByteArray();
    }

    private static byte[] manifestChange(byte[] raw, String key, String value) throws Exception {
        Map<String, byte[]> items = unpack(raw);
        ObjectNode manifest = (ObjectNode) MAPPER.readTree(items.get("manifest.json"));
        manifest.put(key, value);
        items.put("manifest.json", MAPPER.writeValueAsBytes(manifest));
        return zip(items);
    }

    private static String hash(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder s = new StringBuilder();
        for (byte b : digest) s.append(String.format("%02x", b & 0xff));
        return s.toString();
    }

    private static byte[] modifiedPayload(byte[] raw, boolean updateInventory) throws Exception {
        Map<String, byte[]> items = unpack(raw);
        ObjectNode payload = (ObjectNode) MAPPER.readTree(items.get("payload.json"));
        ((ObjectNode) payload.path("tasks").get(0)).put("parandusId", "TEST-A1-MISSING-PARANDUS");
        byte[] data = MAPPER.writeValueAsBytes(payload);
        items.put("payload.json", data);
        if (updateInventory) {
            ObjectNode manifest = (ObjectNode) MAPPER.readTree(items.get("manifest.json"));
            ObjectNode rec = (ObjectNode) manifest.path("files").get(0);
            rec.put("byteLength", data.length);
            rec.put("sha256", hash(data));
            items.put("manifest.json", MAPPER.writeValueAsBytes(manifest));
        }
        return zip(items);
    }

    private static void reject(byte[] archive, String expectedCode) throws Exception {
        try {
            WorkPackageReader.read(archive, DATASET);
            fail("Expected rejection " + expectedCode);
        } catch (WorkPackageReader.PackageException e) {
            assertEquals(expectedCode, e.code);
        }
    }

    @Test public void readsA1FixtureAndLinks() throws Exception {
        byte[] raw = fixture();
        WorkPackageReader.Result result = WorkPackageReader.read(raw, DATASET);
        assertEquals("bac9c885a1010719259ca84738ac0dd85fe8442e66fe92a2890496beb312a8a4", result.archiveSha256);
        assertEquals("TEST-A1-KILP-001", result.payload.path("cabinets").get(0).path("kilpId").asText());
        assertEquals("TEST-A1-KONTROLL-001", result.payload.path("lastInspections").get(0).path("kontrollId").asText());
        assertEquals("TEST-A1-PUUDUS-001", result.payload.path("openDefects").get(0).path("puudusId").asText());
        assertEquals("TEST-A1-PARANDUS-001", result.payload.path("repairs").get(0).path("parandusId").asText());
        assertEquals("RECHECK", result.payload.path("tasks").get(0).path("type").asText());
        assertEquals("TEST", result.manifest.path("environment").asText());
    }

    @Test public void wrongExpectedDatasetRejected() throws Exception {
        try {
            WorkPackageReader.read(fixture(), "TEST-SOME-OTHER-DATASET");
            fail("Wrong dataset must fail");
        } catch (WorkPackageReader.PackageException e) { assertEquals("DATASET", e.code); }
    }

    @Test public void productionEnvironmentRejected() throws Exception { reject(manifestChange(fixture(), "environment", "PRODUCTION"), "ENVIRONMENT"); }
    @Test public void contractVersionRejected() throws Exception { reject(manifestChange(fixture(), "contractVersion", "0.2-test"), "CONTRACT"); }
    @Test public void corruptPayloadHashRejected() throws Exception { reject(modifiedPayload(fixture(), false), "FILE_HASH"); }
    @Test public void brokenRecheckLinkRejectedEvenWithValidHash() throws Exception { reject(modifiedPayload(fixture(), true), "TASK"); }
    @Test public void unsupportedChangeRejected() throws Exception { reject(manifestChange(fixture(), "packageType", "CHANGE_PACKAGE"), "UNSUPPORTED_IN_A2"); }
    @Test public void truncatedZipRejected() throws Exception { reject(Arrays.copyOf(fixture(), fixture().length - 15), "ZIP"); }
    @Test public void unlistedEntryRejected() throws Exception {
        Map<String, byte[]> items = unpack(fixture());
        items.put("extra.bin", new byte[]{1, 2, 3});
        reject(zip(items), "INVENTORY");
    }
    @Test public void traversalEntryRejected() throws Exception {
        Map<String, byte[]> items = unpack(fixture());
        items.put("../evil.json", new byte[]{1});
        reject(zip(items), "ZIP_PATH");
    }
    @Test public void invalidJsonRejected() throws Exception {
        Map<String, byte[]> items = unpack(fixture());
        items.put("manifest.json", "{broken".getBytes(StandardCharsets.UTF_8));
        reject(zip(items), "JSON");
    }
    @Test public void repeatedManifestJsonKeyRejected() throws Exception {
        Map<String, byte[]> items = unpack(fixture());
        String manifest = new String(items.get("manifest.json"), StandardCharsets.UTF_8);
        manifest = "{\"contractVersion\":\"0.1-test\"," + manifest.substring(1);
        items.put("manifest.json", manifest.getBytes(StandardCharsets.UTF_8));
        reject(zip(items), "JSON");
    }
    @Test public void symlinkFlagRejected() throws Exception {
        byte[] raw = fixture().clone();
        ByteBuffer b = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
        // Central-directory signature. Set mode=0120777 (Unix symbolic link).
        int p = -1;
        for (int i = 0; i + 46 < raw.length; i++) {
            if (b.getInt(i) == 0x02014b50) { p = i; break; }
        }
        assertTrue(p > 0);
        b.putInt(p + 38, (int) (0120777L << 16));
        reject(raw, "ZIP");
    }
    @Test public void duplicateZipPathRejected() throws Exception {
        // Rebuild an archive with two same-length central+local names by editing the second one.
        Map<String, byte[]> items = unpack(fixture());
        items.put("extra.bin", new byte[]{9});
        items.put("other.bin", new byte[]{8});
        byte[] raw = zip(items);
        byte[] old = "other.bin".getBytes(StandardCharsets.US_ASCII);
        byte[] replacement = "extra.bin".getBytes(StandardCharsets.US_ASCII);
        int replaced = 0;
        for (int i = 0; i <= raw.length - old.length; i++) {
            boolean found = true;
            for (int j = 0; j < old.length; j++) if (raw[i+j] != old[j]) found = false;
            if (found) {
                System.arraycopy(replacement, 0, raw, i, replacement.length);
                replaced++;
            }
        }
        assertEquals(2, replaced);
        reject(raw, "ZIP");
    }
    @Test public void tooManyZipEntriesRejected() throws Exception {
        Map<String, byte[]> items = unpack(fixture());
        for (int i = 0; i < 999; i++) items.put("TEST-A2-EXTRA-" + i + ".bin", new byte[]{1});
        reject(zip(items), "ZIP");
    }
    @Test public void inflatedJsonOverLimitRejected() throws Exception {
        Map<String, byte[]> items = unpack(fixture());
        byte[] huge = new byte[4 * 1024 * 1024 + 1];
        Arrays.fill(huge, (byte) ' ');
        items.put("payload.json", huge);
        reject(zip(items), "ZIP_LIMIT");
    }

}
