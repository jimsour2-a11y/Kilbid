package ee.dold.techcontrol.v2storage;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
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

    @Test public void committedReceiptMetadataCanBeReadBackWithoutSchemaChanges() throws Exception {
        store.importPackage(fixture(), DATASET);
        WorkPackageStore.StoredReceipt receipt = store.getLatestReceipt();
        assertNotNull(receipt);
        assertEquals("TEST-A1-PACKAGE-001", receipt.packageId);
        assertEquals("TEST-A1-SNAPSHOT-001", receipt.snapshotId);
        assertEquals(DATASET, receipt.datasetId);
        assertEquals(hash(fixture()), receipt.archiveSha256);
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

    @Test public void createsLocalInspectionAndJournalAtomically() throws Exception {
        store.importPackage(fixture(), DATASET);
        JsonNode inspection = localInspection("TEST-A4-KONTROLL-001", "TEST-A1-KILP-001", "Local test inspection");
        WorkPackageStore.LocalWriteResult result = store.createLocalInspection("TEST-A4-CHANGE-001", "TEST-A4-DEVICE-001", inspection);
        assertEquals(WorkPackageStore.LocalWriteStatus.CREATED, result.status);
        assertEquals(2, store.getInspectionCount());
        assertEquals(1, store.getLocalChangeCount());
        WorkPackageStore.StoredLocalChange change = store.getLocalChange("TEST-A4-CHANGE-001");
        assertNotNull(change);
        assertEquals("Kontroll", change.entityType);
        assertEquals("CREATE", change.operation);
        assertEquals("TEST-A4-KONTROLL-001", change.entityId);
        assertEquals(0, change.baseRevision);
        assertEquals(1, change.revision);
        assertEquals("TEST-A4-DEVICE-001", change.originDeviceId);
        assertEquals("TEST-A4-PERSON-001", change.actorPersonId);
        assertEquals("PENDING_LOCAL", change.status);
        assertEquals(JSON.writeValueAsString(inspection), change.payloadJson);
        assertEquals(change.payloadSha256, hash(change.payloadJson.getBytes(StandardCharsets.UTF_8)));
        assertEquals("TEST-A1-KILP-001", JSON.readTree(store.getPreviousInspection("TEST-A4-KONTROLL-001").rawJson).path("kilpId").asText());
    }

    @Test public void localInspectionAndChangeSurviveDatabaseReopen() throws Exception {
        store.importPackage(fixture(), DATASET);
        store.createLocalInspection("TEST-A4-CHANGE-002", "TEST-A4-DEVICE-001", localInspection("TEST-A4-KONTROLL-002", "TEST-A1-KILP-001", "Persisted"));
        store.close();
        store = new WorkPackageStore(context, databaseName);
        assertNotNull(store.getPreviousInspection("TEST-A4-KONTROLL-002"));
        assertEquals("TEST-A4-KONTROLL-002", store.getLocalChange("TEST-A4-CHANGE-002").entityId);
        assertEquals(1, store.getLocalChangeCount());
        assertEquals("TEST-A1-PUUDUS-001", store.getDefect("TEST-A1-PUUDUS-001").id);
    }

    @Test public void identicalLocalRetryIsIdempotent() throws Exception {
        store.importPackage(fixture(), DATASET);
        JsonNode inspection = localInspection("TEST-A4-KONTROLL-003", "TEST-A1-KILP-001", "Retry");
        assertEquals(WorkPackageStore.LocalWriteStatus.CREATED,
                store.createLocalInspection("TEST-A4-CHANGE-003", "TEST-A4-DEVICE-001", inspection).status);
        assertEquals(WorkPackageStore.LocalWriteStatus.ALREADY_PRESENT,
                store.createLocalInspection("TEST-A4-CHANGE-003", "TEST-A4-DEVICE-001", inspection).status);
        assertEquals(2, store.getInspectionCount());
        assertEquals(1, store.getLocalChangeCount());
    }

    @Test public void sameChangeIdWithDifferentDataIsRejected() throws Exception {
        store.importPackage(fixture(), DATASET);
        store.createLocalInspection("TEST-A4-CHANGE-004", "TEST-A4-DEVICE-001", localInspection("TEST-A4-KONTROLL-004", "TEST-A1-KILP-001", "First"));
        try {
            store.createLocalInspection("TEST-A4-CHANGE-004", "TEST-A4-DEVICE-001", localInspection("TEST-A4-KONTROLL-004", "TEST-A1-KILP-001", "Changed"));
            fail("Expected change identity conflict");
        } catch (WorkPackageStore.StoreException e) { assertEquals("CHANGE_ID_CONFLICT", e.code); }
        assertEquals(2, store.getInspectionCount());
        assertEquals(1, store.getLocalChangeCount());
    }

    @Test public void existingKontrollIdWithAnotherChangeIsRejected() throws Exception {
        store.importPackage(fixture(), DATASET);
        try {
            store.createLocalInspection("TEST-A4-CHANGE-005", "TEST-A4-DEVICE-001", localInspection("TEST-A1-KONTROLL-001", "TEST-A1-KILP-001", "Collision"));
            fail("Expected KontrollID conflict");
        } catch (WorkPackageStore.StoreException e) { assertEquals("KONTROLL_ID_CONFLICT", e.code); }
        assertEquals(1, store.getInspectionCount());
        assertEquals(0, store.getLocalChangeCount());
    }

    @Test public void missingCabinetIsRejectedWithoutWrites() throws Exception {
        store.importPackage(fixture(), DATASET);
        try {
            store.createLocalInspection("TEST-A4-CHANGE-006", "TEST-A4-DEVICE-001", localInspection("TEST-A4-KONTROLL-006", "TEST-MISSING-KILP", "No cabinet"));
            fail("Expected cabinet rejection");
        } catch (WorkPackageStore.StoreException e) { assertEquals("CABINET_NOT_FOUND", e.code); }
        assertEquals(1, store.getInspectionCount());
        assertEquals(0, store.getLocalChangeCount());
    }

    @Test public void journalFailureRollsBackInspectionInsert() throws Exception {
        store.importPackage(fixture(), DATASET);
        store.close();
        SQLiteDatabase db = context.openOrCreateDatabase(databaseName, Context.MODE_PRIVATE, null);
        db.execSQL("CREATE TRIGGER fail_local_change BEFORE INSERT ON local_changes BEGIN SELECT RAISE(ABORT, 'forced test failure'); END");
        db.close();
        store = new WorkPackageStore(context, databaseName);
        try {
            store.createLocalInspection("TEST-A4-CHANGE-007", "TEST-A4-DEVICE-001", localInspection("TEST-A4-KONTROLL-007", "TEST-A1-KILP-001", "Rollback"));
            fail("Expected forced SQLite failure");
        } catch (WorkPackageStore.StoreException e) { assertEquals("LOCAL_WRITE_ROLLED_BACK", e.code); }
        assertNull(store.getPreviousInspection("TEST-A4-KONTROLL-007"));
        assertEquals(1, store.getInspectionCount());
        assertEquals(0, store.getLocalChangeCount());
    }

    @Test public void versionOneDatabaseUpgradePreservesImportedRecords() throws Exception {
        store.close();
        LegacyV1Helper legacy = new LegacyV1Helper(context, databaseName);
        SQLiteDatabase oldDb = legacy.getWritableDatabase();
        oldDb.execSQL("INSERT INTO dataset_lock(dataset_id) VALUES(?)", new Object[]{DATASET});
        oldDb.execSQL("INSERT INTO package_receipts(dataset_id,package_id,snapshot_id,archive_sha256,manifest_json,payload_json,imported_at_utc) VALUES(?,?,?,?,?,?,?)",
                new Object[]{DATASET, "TEST-A1-PACKAGE-001", "TEST-A1-SNAPSHOT-001", hash(fixture()), "{}", "{}", 1L});
        oldDb.execSQL("INSERT INTO cabinets(dataset_id,kilp_id,revision,raw_json) VALUES(?,?,?,?)",
                new Object[]{DATASET, "TEST-A1-KILP-001", 1, "{\"kilpId\":\"TEST-A1-KILP-001\"}"});
        oldDb.execSQL("INSERT INTO inspections(dataset_id,kontroll_id,kilp_id,revision,raw_json) VALUES(?,?,?,?,?)",
                new Object[]{DATASET, "TEST-A1-KONTROLL-001", "TEST-A1-KILP-001", 1, "{\"kontrollId\":\"TEST-A1-KONTROLL-001\",\"kilpId\":\"TEST-A1-KILP-001\"}"});
        oldDb.execSQL("INSERT INTO defects(dataset_id,puudus_id,kilp_id,kontroll_id,revision,raw_json) VALUES(?,?,?,?,?,?)",
                new Object[]{DATASET, "TEST-A1-PUUDUS-001", "TEST-A1-KILP-001", "TEST-A1-KONTROLL-001", 1, "{\"puudusId\":\"TEST-A1-PUUDUS-001\"}"});
        oldDb.execSQL("INSERT INTO repairs(dataset_id,parandus_id,puudus_id,revision,raw_json) VALUES(?,?,?,?,?)",
                new Object[]{DATASET, "TEST-A1-PARANDUS-001", "TEST-A1-PUUDUS-001", 1, "{\"parandusId\":\"TEST-A1-PARANDUS-001\"}"});
        oldDb.execSQL("INSERT INTO recheck_tasks(dataset_id,task_id,type,kilp_id,kontroll_id,puudus_id,parandus_id,revision,raw_json) VALUES(?,?,?,?,?,?,?,?,?)",
                new Object[]{DATASET, "TEST-A1-TASK-001", "RECHECK", "TEST-A1-KILP-001", "TEST-A1-KONTROLL-001", "TEST-A1-PUUDUS-001", "TEST-A1-PARANDUS-001", 1, "{\"taskId\":\"TEST-A1-TASK-001\"}"});
        oldDb.close();
        legacy.close();
        store.close();
        store = new WorkPackageStore(context, databaseName);
        assertEquals(1, store.getReceiptCount());
        assertEquals("TEST-A1-KILP-001", store.getCabinet("TEST-A1-KILP-001").id);
        assertEquals("TEST-A1-KONTROLL-001", store.getPreviousInspection("TEST-A1-KONTROLL-001").id);
        assertEquals("TEST-A1-PUUDUS-001", store.getDefect("TEST-A1-PUUDUS-001").id);
        assertEquals("TEST-A1-PARANDUS-001", store.getRepair("TEST-A1-PARANDUS-001").id);
        assertEquals("TEST-A1-TASK-001", store.getRecheckTask("TEST-A1-TASK-001").id);
        assertEquals(1, store.getInspectionCount());
        assertEquals(0, store.getLocalChangeCount());
    }

    private static JsonNode localInspection(String kontrollId, String kilpId, String remarks) throws Exception {
        return JSON.readTree("{\"kontrollId\":\"" + kontrollId + "\",\"kilpId\":\"" + kilpId
                + "\",\"dateUtc\":\"2026-11-04T12:00:00Z\",\"inspectorPersonId\":\"TEST-A4-PERSON-001\",\"scores\":{\"A\":4},\"remarks\":\""
                + remarks + "\",\"revision\":1}");
    }

    private static final class LegacyV1Helper extends SQLiteOpenHelper {
        LegacyV1Helper(Context context, String name) { super(context, name, null, 1); }
        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE dataset_lock(dataset_id TEXT PRIMARY KEY NOT NULL)");
            db.execSQL("CREATE TABLE package_receipts(dataset_id TEXT NOT NULL, package_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, archive_sha256 TEXT NOT NULL, manifest_json TEXT NOT NULL, payload_json TEXT NOT NULL, imported_at_utc INTEGER NOT NULL, PRIMARY KEY(dataset_id, package_id), FOREIGN KEY(dataset_id) REFERENCES dataset_lock(dataset_id))");
            db.execSQL("CREATE TABLE cabinets(dataset_id TEXT NOT NULL, kilp_id TEXT NOT NULL, revision INTEGER, raw_json TEXT NOT NULL, PRIMARY KEY(dataset_id, kilp_id), FOREIGN KEY(dataset_id) REFERENCES dataset_lock(dataset_id))");
            db.execSQL("CREATE TABLE inspections(dataset_id TEXT NOT NULL, kontroll_id TEXT NOT NULL, kilp_id TEXT NOT NULL, revision INTEGER, raw_json TEXT NOT NULL, PRIMARY KEY(dataset_id, kontroll_id), FOREIGN KEY(dataset_id, kilp_id) REFERENCES cabinets(dataset_id, kilp_id))");
            db.execSQL("CREATE TABLE defects(dataset_id TEXT NOT NULL, puudus_id TEXT NOT NULL, kilp_id TEXT NOT NULL, kontroll_id TEXT NOT NULL, revision INTEGER, raw_json TEXT NOT NULL, PRIMARY KEY(dataset_id, puudus_id), FOREIGN KEY(dataset_id, kilp_id) REFERENCES cabinets(dataset_id, kilp_id), FOREIGN KEY(dataset_id, kontroll_id) REFERENCES inspections(dataset_id, kontroll_id))");
            db.execSQL("CREATE TABLE repairs(dataset_id TEXT NOT NULL, parandus_id TEXT NOT NULL, puudus_id TEXT NOT NULL, revision INTEGER, raw_json TEXT NOT NULL, PRIMARY KEY(dataset_id, parandus_id), FOREIGN KEY(dataset_id, puudus_id) REFERENCES defects(dataset_id, puudus_id))");
            db.execSQL("CREATE TABLE recheck_tasks(dataset_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, kilp_id TEXT NOT NULL, kontroll_id TEXT, puudus_id TEXT, parandus_id TEXT, revision INTEGER, raw_json TEXT NOT NULL, PRIMARY KEY(dataset_id, task_id), FOREIGN KEY(dataset_id, kilp_id) REFERENCES cabinets(dataset_id, kilp_id), FOREIGN KEY(dataset_id, kontroll_id) REFERENCES inspections(dataset_id, kontroll_id), FOREIGN KEY(dataset_id, puudus_id) REFERENCES defects(dataset_id, puudus_id), FOREIGN KEY(dataset_id, parandus_id) REFERENCES repairs(dataset_id, parandus_id))");
        }
        @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { throw new AssertionError("Not used"); }
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
