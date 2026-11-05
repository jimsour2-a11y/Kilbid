package ee.dold.techcontrol;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.view.WindowInsets;
import android.widget.EditText;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import ee.dold.techcontrol.v2storage.WorkPackageStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.time.Instant;
import java.util.UUID;

/** Isolated, read-only host for synthetic TEST WORK packages. */
public final class V2TestActivity extends Activity {
    private static final int PICK_PACKAGE = 41;
    private static final String DB_NAME = "kilbid_v2_test.sqlite";
    private static final int MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private WorkPackageStore store;
    private TextView statusView;
    private TextView recordsView;
    private Button importButton;
    private Button createButton;
    private EditText inspectorInput, scoreInput, remarksInput;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        store = new WorkPackageStore(getApplicationContext(), DB_NAME);
        buildUi();
        reloadFromDatabase();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        page.setPadding(pad, pad, pad, pad);
        TextView title = new TextView(this);
        title.setText("DOLD TechControl | Kilbid v2 TEST");
        title.setTextSize(22);
        title.setGravity(Gravity.START);
        page.addView(title);

        Button back = new Button(this);
        back.setText("Tagasi Kilbid v1");
        back.setOnClickListener(v -> finish());
        page.addView(back);

        importButton = new Button(this);
        importButton.setText("Impordi TEST-pakett");
        importButton.setOnClickListener(v -> openPicker());
        page.addView(importButton);

        inspectorInput = new EditText(this);
        inspectorInput.setHint("TEST inspektori ID");
        page.addView(inspectorInput);
        scoreInput = new EditText(this);
        scoreInput.setHint("Hinne A (0–5)");
        scoreInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        page.addView(scoreInput);
        remarksInput = new EditText(this);
        remarksInput.setHint("Märkus");
        page.addView(remarksInput);
        createButton = new Button(this);
        createButton.setText("Salvesta uus TEST kontroll");
        createButton.setOnClickListener(v -> createInspection());
        page.addView(createButton);

        statusView = new TextView(this);
        statusView.setTextIsSelectable(true);
        statusView.setPadding(0, dp(12), 0, dp(12));
        page.addView(statusView);

        recordsView = new TextView(this);
        recordsView.setTextIsSelectable(true);
        recordsView.setTextSize(16);
        recordsView.setPadding(0, dp(8), 0, dp(24));
        page.addView(recordsView);
        scroll.addView(page);
        if (Build.VERSION.SDK_INT >= 30) {
            scroll.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                page.setPadding(pad, pad + bars.top, pad, pad + bars.bottom);
                return insets;
            });
        }
        setContentView(scroll);
    }

    private void createInspection() {
        if (store.getCabinet("TEST-A1-KILP-001") == null) {
            statusView.setText("Impordi esmalt TEST-pakett."); return;
        }
        String person = inspectorInput.getText().toString().trim();
        String scoreText = scoreInput.getText().toString().trim();
        int score;
        try { score = Integer.parseInt(scoreText); }
        catch (NumberFormatException e) { score = -1; }
        if (person.isEmpty() || score < 0 || score > 5 || !person.startsWith("TEST-")) {
            statusView.setText("Sisesta TEST inspektori ID ja hinne 0–5."); return;
        }
        String kontrollId = "TEST-LOCAL-KONTROLL-" + UUID.randomUUID();
        String changeId = "TEST-LOCAL-CHANGE-" + UUID.randomUUID();
        String deviceId = getPreferences(MODE_PRIVATE).getString("v2_test_device_id", null);
        if (deviceId == null) {
            deviceId = "TEST-LOCAL-DEVICE-" + UUID.randomUUID();
            getPreferences(MODE_PRIVATE).edit().putString("v2_test_device_id", deviceId).apply();
        }
        ObjectNode inspection = new ObjectMapper().createObjectNode();
        inspection.put("kontrollId", kontrollId);
        inspection.put("kilpId", "TEST-A1-KILP-001");
        inspection.put("dateUtc", Instant.now().toString());
        inspection.put("inspectorPersonId", person);
        inspection.putObject("scores").put("A", score);
        inspection.put("remarks", remarksInput.getText().toString());
        inspection.put("revision", 1);
        try {
            store.createLocalInspection(changeId, deviceId, inspection);
            statusView.setText("TEST kontroll salvestatud: " + kontrollId);
            reloadRecordsOnly();
        } catch (WorkPackageStore.StoreException e) {
            statusView.setText("TEST kontrolli ei salvestatud: " + e.code);
        }
    }

    private int dp(int value) { return (int) (value * getResources().getDisplayMetrics().density + 0.5f); }

    private void openPicker() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        // A .dtcpkg provider may declare a device-dependent MIME type.
        // Accept any document here; the A2 reader validates the package bytes.
        intent.putExtra(Intent.EXTRA_TITLE, "TEST .dtcpkg");
        startActivityForResult(intent, PICK_PACKAGE);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_PACKAGE || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        statusView.setText("Paketi loetakse ja kontrollitakse…");
        importButton.setEnabled(false);
        io.execute(() -> {
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) throw new IllegalStateException("Valitud faili ei saa avada.");
                byte[] bytes = readLimited(in);
                WorkPackageStore.ImportResult result = store.importPackage(bytes, WorkPackageStore.TEST_DATASET);
                main.post(() -> showImportResult(result));
            } catch (Exception e) {
                main.post(() -> {
                    importButton.setEnabled(true);
                    statusView.setText("Import ebaõnnestus: " + safeMessage(e) + "\nSalvestatud kirjed säilivad.");
                    reloadRecordsOnly();
                });
            }
        });
    }

    private byte[] readLimited(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) != -1) {
            if (out.size() + (long) n > MAX_PACKAGE_BYTES) throw new IllegalArgumentException("Fail ületab lubatud TEST-paketi suuruse.");
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }

    private static String safeMessage(Exception e) {
        String message = e.getMessage();
        return message == null || message.trim().isEmpty() ? e.getClass().getSimpleName() : message;
    }

    private void showImportResult(WorkPackageStore.ImportResult result) {
        importButton.setEnabled(true);
        if (result.status == WorkPackageStore.ImportStatus.UNSUPPORTED_PARTIAL) {
            statusView.setText("Osaline WORK-pakett pole selles etapis toetatud. Andmebaasi ei muudetud.");
            reloadRecordsOnly();
            return;
        }
        String label = result.status == WorkPackageStore.ImportStatus.IMPORTED ? "IMPORTED" : "ALREADY_IMPORTED";
        reloadFromDatabase(label);
    }

    private void reloadFromDatabase() { reloadFromDatabase("SQLite salvestatud"); }

    private void reloadFromDatabase(String importStatus) {
        WorkPackageStore.StoredReceipt receipt = store.getLatestReceipt();
        if (receipt == null) {
            statusView.setText("TEST-pakett pole veel imporditud.");
            recordsView.setText("");
            return;
        }
        statusView.setText("Pakett: " + receipt.packageId + "\nSnapshot: " + receipt.snapshotId
                + "\nDataset: " + receipt.datasetId + "\nImport: " + importStatus);
        reloadRecordsOnly();
    }

    private void reloadRecordsOnly() {
        WorkPackageStore.StoredReceipt receipt = store.getLatestReceipt();
        if (receipt == null) { recordsView.setText(""); return; }
        StringBuilder out = new StringBuilder();
        append(out, "Kilp", store.getCabinet("TEST-A1-KILP-001"));
        append(out, "Viimane kontroll", store.getPreviousInspection("TEST-A1-KONTROLL-001"));
        append(out, "Puudus", store.getDefect("TEST-A1-PUUDUS-001"));
        append(out, "Parandus", store.getRepair("TEST-A1-PARANDUS-001"));
        append(out, "Järelkontroll", store.getRecheckTask("TEST-A1-TASK-001"));
        WorkPackageStore.StoredLocalChange change = store.getLatestLocalChange();
        if (change != null) append(out, "Uus kohalik kontroll", store.getPreviousInspection(change.entityId));
        recordsView.setText(out.toString());
    }

    private static void append(StringBuilder out, String label, WorkPackageStore.StoredRecord row) {
        out.append(label).append(": ");
        if (row == null) { out.append("puudub\n\n"); return; }
        out.append(row.id);
        if (row.revision >= 0) out.append(" (revision ").append(row.revision).append(")");
        out.append("\n").append(row.rawJson).append("\n\n");
    }

    /* Package-private for Robolectric behavior tests; exercises the same storage path as document import. */
    WorkPackageStore.ImportResult importBytesForTest(byte[] bytes) throws WorkPackageStore.StoreException {
        WorkPackageStore.ImportResult result = store.importPackage(bytes, WorkPackageStore.TEST_DATASET);
        if (result.status == WorkPackageStore.ImportStatus.UNSUPPORTED_PARTIAL) {
            statusView.setText("Osaline WORK-pakett pole selles etapis toetatud. Andmebaasi ei muudetud.");
            reloadRecordsOnly();
        } else {
            reloadFromDatabase(result.status.toString());
        }
        return result;
    }

    TextView recordsViewForTest() { return recordsView; }
    TextView statusViewForTest() { return statusView; }
    EditText inspectorForTest() { return inspectorInput; }
    EditText scoreForTest() { return scoreInput; }
    EditText remarksForTest() { return remarksInput; }
    Button createForTest() { return createButton; }

    @Override protected void onDestroy() {
        io.shutdownNow();
        if (store != null) store.close();
        super.onDestroy();
    }
}
