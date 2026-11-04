package ee.dold.techcontrol.v2storage;

import android.content.Context;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class WorkPackageStoreTest {
    private static final String DATASET = WorkPackageStore.TEST_DATASET;
    private static final ObjectMapper JSON = new ObjectMapper();
    private Context context;
    private String databaseName;
    private WorkPackageStore store;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        databaseName = "a3-test-" + System.nanoTime() + ".db";
        store = new WorkPackageStore(context, databaseName);
    }

    @After public void tearDown() {
        if (store != null) store.close();
        context.deleteDatabase(databaseName);
    }

    private byte[] fixture() throws Exception {
        try (InputStream in = getClass().getResourceAsStream("/TEST_A1_WORK_PACKAGE.dtcpkg")) {
            assertNotNull("A1 synthetic fixture required", in);
            return in.readAllBytes();
        }
    }

    @Test public void importsAllExpectedEntitiesAndStableIds() throws Exception {
        WorkPackageStore.ImportResult result = store.importPackage(fixture(), DATASET);
        assertEquals(WorkPackageStore.ImportStatus.IMPORTED, result.status);
        assertEquals(1, store.getReceiptCount());
        assertEquals(1, store.getCabinetCount());
        assertEquals(1, store.getInspectionCount());
        assertEquals(1, store.getDefectCount());
        assertEquals(1, store.getRepairCount());
        assertEquals(1, store.getTaskCount());
        assertEquals("TEST-A1-KILP-001", store.getCabinet("TEST-A1-KILP-001").id);
        assertEquals("TEST-A1-KONTROLL-001", store.getPreviousInspection("TEST-A1-KONTROLL-001").id);
        assertEquals("TEST-A1-PUUDUS-001", store.getDefect("TEST-A1-PUUDUS-001").id);
        assertEquals("TEST-A1-PARANDUS-001", store.getRepair("TEST-A1-PARANDUS-001").id);
        assertEquals("TEST-A1-TASK-001", store.getRecheckTask("TEST-A1-TASK-001").id);
    }

    @Test public void originalRecordFieldsAndRevisionArePreserved() throws Exception {
        store.importPackage(fixture(), DATASET);
        WorkPackageStore.StoredRecord inspection = store.getPreviousInspection("TEST-A1-KONTROLL-001");
        JsonNode saved = JSON.readTree(inspection.rawJson);
        assertEquals(1, inspection.revision);
        assertEquals("Artificial inspection", saved.path("remarks").asText());
        assertEquals(3, saved.path("scores").path("A").asInt());
        assertEquals("TEST-A1-AREA", JSON.readTree(store.getCabinet("TEST-A1-KILP-001").rawJson).path("area").asText());
    }

    @Test public void recordsSurviveClosingAndReopeningDatabase() throws Exception {
        store.importPackage(fixture(), DATASET);
        store.close();
        store = new WorkPackageStore(context, databaseName);
        assertEquals("TEST-A1-PARANDUS-001", store.getRepair("TEST-A1-PARANDUS-001").id);
        assertEquals("TEST-A1-TASK-001", store.getRecheckTask("TEST-A1-TASK-001").id);
        assertEquals(1, store.getReceiptCount());
    }

    @Test public void reimportOfSamePackageAndHashIsIdempotent() throws Exception {
        byte[] raw = fixture();
        store.importPackage(raw, DATASET);
        assertEquals(WorkPackageStore.ImportStatus.ALREADY_IMPORTED, store.importPackage(raw, DATASET).status);
        assertEquals(1, store.getReceiptCount());
        assertEquals(1, store.getDefectCount());
    }

    @Test public void packageIdWithDifferentArchiveHashIsRejected() throws Exception {
        byte[] original = fixture();
        store.importPackage(original, DATASET);
        byte[] changed = changeManifest(original, "createdAtUtc", "2026-11-03T12:01:00Z");
        assertNotEquals(hash(original), hash(changed));
        try { store.importPackage(changed, DATASET); fail("Expected package ID collision"); }
        catch (WorkPackageStore.StoreException e) { assertEquals("PACKAGE_ID_COLLISION", e.code); }
        assertEquals(1, store.getReceiptCount());
        assertEquals(1, store.getCabinetCount());
    }

    @Test public void wrongEnvironmentCannotModifyDatabase() throws Exception {
        try { store.importPackage(changeManifest(fixture(), "environment", "PRODUCTION"), DATASET); fail("Expected rejection"); }
        catch (WorkPackageStore.StoreException e) { assertEquals("PACKAGE_REJECTED", e.code); }
        assertEmpty();
    }

    @Test public void wrongDatasetCannotModifyDatabase() throws Exception {
        try { store.importPackage(fixture(), "TEST-OTHER-DATASET"); fail("Expected rejection"); }
        catch (WorkPackageStore.StoreException e) { assertEquals("PACKAGE_REJECTED", e.code); }
        assertEmpty();
    }

    @Test public void corruptedArchiveCannotModifyDatabase() throws Exception {
        byte[] bad = fixture(); bad[bad.length / 2] ^= 0x35;
        try { store.importPackage(bad, DATASET); fail("Expected rejection"); }
        catch (WorkPackageStore.StoreException e) { assertEquals("PACKAGE_REJECTED", e.code); }
        assertEmpty();
    }

    @Test public void conflictingEntityRollsBackEarlierInsertsAndReceipt() throws Exception {
        store.importPackage(fixture(), DATASET);
        byte[] second = packageWithNewEntitiesButCollidingRepair(fixture());
        try { store.importPackage(second, DATASET); fail("Expected stable-ID collision"); }
        catch (WorkPackageStore.StoreException e) { assertEquals("ENTITY_ID_COLLISION", e.code); }
        assertEquals(1, store.getReceiptCount());
        assertEquals(1, store.getCabinetCount());
        assertEquals(1, store.getInspectionCount());
        assertEquals(1, store.getDefectCount());
        assertEquals(1, store.getRepairCount());
        assertEquals(1, store.getTaskCount());
        assertNull(store.getCabinet("TEST-A3-KILP-002"));
    }

    @Test public void partialWorkPackageReturnsExplicitUnsupportedWithoutWrites() throws Exception {
        byte[] delta = withPayloadChanges(fixture(), p -> {
            p.put("fullSnapshot", false);
            p.put("baseSnapshotId", "TEST-A1-SNAPSHOT-PREVIOUS");
        });
        assertEquals(WorkPackageStore.ImportStatus.UNSUPPORTED_PARTIAL, store.importPackage(delta, DATASET).status);
        assertEmpty();
    }

    @Test public void relationshipsRemainQueryableAfterImport() throws Exception {
        store.importPackage(fixture(), DATASET);
        JsonNode task = JSON.readTree(store.getRecheckTask("TEST-A1-TASK-001").rawJson);
        assertEquals("TEST-A1-KILP-001", task.path("kilpId").asText());
        assertEquals("TEST-A1-KONTROLL-001", task.path("kontrollId").asText());
        assertEquals("TEST-A1-PUUDUS-001", task.path("puudusId").asText());
        assertEquals("TEST-A1-PARANDUS-001", task.path("parandusId").asText());
    }

    private void assertEmpty() {
        assertEquals(0, store.getReceiptCount()); assertEquals(0, store.getCabinetCount());
        assertEquals(0, store.getInspectionCount()); assertEquals(0, store.getDefectCount());
        assertEquals(0, store.getRepairCount()); assertEquals(0, store.getTaskCount());
    }

    private interface PayloadEdit { void apply(ObjectNode payload) throws Exception; }
    private static byte[] withPayloadChanges(byte[] raw, PayloadEdit edit) throws Exception {
        Map<String, byte[]> items = unpack(raw);
        ObjectNode payload = (ObjectNode) JSON.readTree(items.get("payload.json"));
        edit.apply(payload);
        byte[] body = JSON.writeValueAsBytes(payload);
        items.put("payload.json", body);
        ObjectNode manifest = (ObjectNode) JSON.readTree(items.get("manifest.json"));
        ObjectNode file = (ObjectNode) manifest.path("files").get(0);
        file.put("byteLength", body.length); file.put("sha256", hash(body));
        items.put("manifest.json", JSON.writeValueAsBytes(manifest));
        return zip(items);
    }

    private static byte[] packageWithNewEntitiesButCollidingRepair(byte[] raw) throws Exception {
        byte[] changed = withPayloadChanges(raw, p -> {
            ((ObjectNode) p.path("cabinets").get(0)).put("kilpId", "TEST-A3-KILP-002");
            ((ObjectNode) p.path("lastInspections").get(0)).put("kilpId", "TEST-A3-KILP-002").put("kontrollId", "TEST-A3-KONTROLL-002");
            ((ObjectNode) p.path("openDefects").get(0)).put("kilpId", "TEST-A3-KILP-002").put("kontrollId", "TEST-A3-KONTROLL-002").put("puudusId", "TEST-A3-PUUDUS-002");
            ((ObjectNode) p.path("repairs").get(0)).put("puudusId", "TEST-A3-PUUDUS-002");
            ((ObjectNode) p.path("tasks").get(0)).put("kilpId", "TEST-A3-KILP-002").put("kontrollId", "TEST-A3-KONTROLL-002").put("puudusId", "TEST-A3-PUUDUS-002");
        });
        return changeManifest(changed, "packageId", "TEST-A3-PACKAGE-002");
    }

    private static byte[] changeManifest(byte[] raw, String key, String value) throws Exception {
        Map<String, byte[]> items = unpack(raw);
        ObjectNode manifest = (ObjectNode) JSON.readTree(items.get("manifest.json"));
        manifest.put(key, value); items.put("manifest.json", JSON.writeValueAsBytes(manifest)); return zip(items);
    }
    private static Map<String, byte[]> unpack(byte[] raw) throws Exception {
        Map<String, byte[]> out = new LinkedHashMap<>();
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(raw), StandardCharsets.UTF_8)) {
            ZipEntry e; while ((e = z.getNextEntry()) != null) out.put(e.getName(), z.readAllBytes());
        }
        return out;
    }
    private static byte[] zip(Map<String, byte[]> items) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
            for (Map.Entry<String, byte[]> e : items.entrySet()) { z.putNextEntry(new ZipEntry(e.getKey())); z.write(e.getValue()); z.closeEntry(); }
        }
        return out.toByteArray();
    }
    private static String hash(byte[] bytes) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder s = new StringBuilder();
        for (byte b : d) s.append(String.format("%02x", b & 255)); return s.toString();
    }
}
