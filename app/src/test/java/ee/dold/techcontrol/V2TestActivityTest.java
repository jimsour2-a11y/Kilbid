package ee.dold.techcontrol;

import android.content.Context;
import ee.dold.techcontrol.v2storage.WorkPackageStore;
import java.io.InputStream;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class V2TestActivityTest {
    private Context context;
    private ActivityController<V2TestActivity> controller;
    private V2TestActivity activity;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase("kilbid_v2_test.sqlite");
        controller = Robolectric.buildActivity(V2TestActivity.class).create().start().resume();
        activity = controller.get();
    }

    @After public void tearDown() {
        controller.destroy();
        context.deleteDatabase("kilbid_v2_test.sqlite");
    }

    private byte[] fixture() throws Exception {
        try (InputStream in = getClass().getResourceAsStream("/TEST_A1_WORK_PACKAGE.dtcpkg")) {
            assertNotNull(in);
            return in.readAllBytes();
        }
    }

    @Test public void importsAndRestoresLocalKontrollWithJournal() throws Exception {
        assertEquals(WorkPackageStore.ImportStatus.IMPORTED, activity.importBytesForTest(fixture()).status);
        activity.inspectorForTest().setText("TEST-PERSON-001");
        activity.scoreForTest().setText("4");
        activity.remarksForTest().setText("TEST märkus");
        activity.createForTest().performClick();
        WorkPackageStore check = new WorkPackageStore(context, "kilbid_v2_test.sqlite");
        String id;
        try {
            WorkPackageStore.StoredLocalChange change = check.getLatestLocalChange();
            assertNotNull(change);
            id = change.entityId;
            assertTrue(id.startsWith("TEST-LOCAL-KONTROLL-"));
            assertEquals("TEST-A1-KILP-001", new com.fasterxml.jackson.databind.ObjectMapper()
                    .readTree(check.getPreviousInspection(id).rawJson).path("kilpId").asText());
            assertEquals(1, check.getLocalChangeCount());
        } finally { check.close(); }
        controller.pause().stop().destroy();
        controller = Robolectric.buildActivity(V2TestActivity.class).create().start().resume();
        activity = controller.get();
        assertTrue(activity.recordsViewForTest().getText().toString().contains(id));
        assertTrue(activity.recordsViewForTest().getText().toString().contains("TEST-A1-KONTROLL-001"));
    }

    @Test public void duplicateImportAndMissingRevisionDisplay() throws Exception {
        byte[] data = fixture();
        activity.importBytesForTest(data);
        assertEquals(WorkPackageStore.ImportStatus.ALREADY_IMPORTED, activity.importBytesForTest(data).status);
        String shown = activity.recordsViewForTest().getText().toString();
        assertTrue(shown.contains("TEST-A1-PARANDUS-001"));
        assertFalse(shown.contains("revision -1"));
        WorkPackageStore check = new WorkPackageStore(context, "kilbid_v2_test.sqlite");
        try { assertEquals(1, check.getReceiptCount()); } finally { check.close(); }
    }
}
