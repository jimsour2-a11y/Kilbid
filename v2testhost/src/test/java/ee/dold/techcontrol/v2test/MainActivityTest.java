package ee.dold.techcontrol.v2test;

import android.content.Context;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import ee.dold.techcontrol.v2storage.WorkPackageStore;
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
import org.robolectric.Robolectric;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class MainActivityTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DB = "v2testhost.sqlite";
    private Context context;
    private MainActivity activity;
    private ActivityController<MainActivity> controller;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(DB);
        controller = Robolectric.buildActivity(MainActivity.class).create().start().resume();
        activity = controller.get();
    }

    @After public void tearDown() {
        if (controller != null) controller.destroy();
        context.deleteDatabase(DB);
    }

    private byte[] fixture() throws Exception {
        try (InputStream in = getClass().getResourceAsStream("/TEST_A1_WORK_PACKAGE.dtcpkg")) {
            assertNotNull("Existing A1 fixture required", in);
            return in.readAllBytes();
        }
    }

    @Test public void validPackageDisplaysAllSyntheticRecordsAndRelationships() throws Exception {
        assertEquals(WorkPackageStore.ImportStatus.IMPORTED, activity.importBytesForTest(fixture()).status);
        String text = activity.recordsViewForTest().getText().toString();
        assertTrue(text.contains("TEST-A1-KILP-001"));
        assertTrue(text.contains("TEST-A1-KONTROLL-001"));
        assertTrue(text.contains("TEST-A1-PUUDUS-001"));
        assertTrue(text.contains("TEST-A1-PARANDUS-001"));
        assertTrue(text.contains("TEST-A1-TASK-001"));
        assertTrue(text.contains("\"kontrollId\":\"TEST-A1-KONTROLL-001\""));
        assertTrue(text.contains("\"parandusId\":\"TEST-A1-PARANDUS-001\""));
        assertTrue(activity.statusViewForTest().getText().toString().contains("TEST-A1-PACKAGE-001"));
        assertTrue(activity.statusViewForTest().getText().toString().contains("TEST-A1-SNAPSHOT-001"));
        assertTrue(activity.statusViewForTest().getText().toString().contains(WorkPackageStore.TEST_DATASET));
    }

    @Test public void newActivityRestoresReceiptAndRecordsFromSqlite() throws Exception {
        activity.importBytesForTest(fixture());
        controller.pause().stop().destroy();
        controller = Robolectric.buildActivity(MainActivity.class).create().start().resume();
        activity = controller.get();
        assertTrue(activity.statusViewForTest().getText().toString().contains("TEST-A1-PACKAGE-001"));
        assertTrue(activity.recordsViewForTest().getText().toString().contains("TEST-A1-PUUDUS-001"));
        assertTrue(activity.recordsViewForTest().getText().toString().contains("TEST-A1-PARANDUS-001"));
    }

    @Test public void repeatedImportIsIdempotent() throws Exception {
        byte[] pkg = fixture();
        assertEquals(WorkPackageStore.ImportStatus.IMPORTED, activity.importBytesForTest(pkg).status);
        assertEquals(WorkPackageStore.ImportStatus.ALREADY_IMPORTED, activity.importBytesForTest(pkg).status);
        WorkPackageStore check = new WorkPackageStore(context, DB);
        try { assertEquals(1, check.getReceiptCount()); } finally { check.close(); }
    }

    @Test public void corruptedArchiveIsRejectedAndPreviouslyStoredDataRemainsVisible() throws Exception {
        activity.importBytesForTest(fixture());
        byte[] bad = fixture(); bad[bad.length / 2] ^= 0x55;
        try { activity.importBytesForTest(bad); fail("Expected corrupted package rejection"); }
        catch (WorkPackageStore.StoreException expected) { assertEquals("PACKAGE_REJECTED", expected.code); }
        assertTrue(activity.recordsViewForTest().getText().toString().contains("TEST-A1-KILP-001"));
    }

    @Test public void wrongEnvironmentIsRejectedWithoutChangingExistingData() throws Exception {
        activity.importBytesForTest(fixture());
        try { activity.importBytesForTest(changeManifest(fixture(), "environment", "PRODUCTION")); fail("Expected environment rejection"); }
        catch (WorkPackageStore.StoreException expected) { assertEquals("PACKAGE_REJECTED", expected.code); }
        assertTrue(activity.recordsViewForTest().getText().toString().contains("TEST-A1-KILP-001"));
    }

    @Test public void wrongDatasetIsRejectedWithoutChangingExistingData() throws Exception {
        activity.importBytesForTest(fixture());
        try { activity.importBytesForTest(fixtureWithDataset("TEST-OTHER-DATASET")); fail("Expected dataset rejection"); }
        catch (WorkPackageStore.StoreException expected) { assertEquals("PACKAGE_REJECTED", expected.code); }
        assertTrue(activity.recordsViewForTest().getText().toString().contains("TEST-A1-KILP-001"));
    }

    @Test public void partialWorkIsExplicitlyUnsupportedWithoutWrites() throws Exception {
        byte[] delta = changePayload(fixture(), p -> p.put("fullSnapshot", false).put("baseSnapshotId", "TEST-A1-SNAPSHOT-BASE"));
        assertEquals(WorkPackageStore.ImportStatus.UNSUPPORTED_PARTIAL, activity.importBytesForTest(delta).status);
        assertTrue(activity.statusViewForTest().getText().toString().contains("pole selles etapis toetatud"));
        WorkPackageStore check = new WorkPackageStore(context, DB);
        try { assertEquals(0, check.getReceiptCount()); } finally { check.close(); }
        assertEquals("", activity.recordsViewForTest().getText().toString());
    }

    @Test public void failedImportDoesNotHidePreviouslyCommittedReceipt() throws Exception {
        activity.importBytesForTest(fixture());
        byte[] bad = fixture(); bad[0] ^= 0x01;
        try { activity.importBytesForTest(bad); fail("Expected rejection"); }
        catch (WorkPackageStore.StoreException expected) { }
        assertTrue(activity.statusViewForTest().getText().toString().contains("TEST-A1-PACKAGE-001"));
    }

    private interface PayloadEdit { void apply(ObjectNode payload) throws Exception; }
    private byte[] fixtureWithDataset(String dataset) throws Exception { return changeManifest(fixture(), "datasetId", dataset); }
    private static byte[] changeManifest(byte[] raw, String key, String value) throws Exception {
        Map<String, byte[]> entries = unpack(raw);
        ObjectNode manifest = (ObjectNode) JSON.readTree(entries.get("manifest.json"));
        manifest.put(key, value); entries.put("manifest.json", JSON.writeValueAsBytes(manifest));
        return zip(entries);
    }
    private static byte[] changePayload(byte[] raw, PayloadEdit edit) throws Exception {
        Map<String, byte[]> entries = unpack(raw);
        ObjectNode payload = (ObjectNode) JSON.readTree(entries.get("payload.json"));
        edit.apply(payload);
        byte[] bytes = JSON.writeValueAsBytes(payload); entries.put("payload.json", bytes);
        ObjectNode manifest = (ObjectNode) JSON.readTree(entries.get("manifest.json"));
        ObjectNode record = (ObjectNode) manifest.path("files").get(0);
        record.put("byteLength", bytes.length); record.put("sha256", sha(bytes));
        entries.put("manifest.json", JSON.writeValueAsBytes(manifest));
        return zip(entries);
    }
    private static Map<String, byte[]> unpack(byte[] raw) throws Exception {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(raw), StandardCharsets.UTF_8)) {
            ZipEntry e; while ((e = in.getNextEntry()) != null) entries.put(e.getName(), in.readAllBytes());
        }
        return entries;
    }
    private static byte[] zip(Map<String, byte[]> entries) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
            for (Map.Entry<String, byte[]> e : entries.entrySet()) { z.putNextEntry(new ZipEntry(e.getKey())); z.write(e.getValue()); z.closeEntry(); }
        }
        return out.toByteArray();
    }
    private static String sha(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder out = new StringBuilder(); for (byte b : digest) out.append(String.format("%02x", b & 255)); return out.toString();
    }
}
