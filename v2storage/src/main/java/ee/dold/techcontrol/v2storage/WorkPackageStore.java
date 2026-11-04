package ee.dold.techcontrol.v2storage;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.SQLException;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.database.sqlite.SQLiteException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import ee.dold.techcontrol.v2reader.WorkPackageReader;
import java.io.Closeable;
import java.io.IOException;
import java.util.Iterator;

/** Isolated durable TEST storage for A3. It has no dependency on :app or v1 storage. */
public final class WorkPackageStore implements Closeable {
    public static final String TEST_DATASET = "TEST-A1-ISOLATED-20261103";
    private static final int DB_VERSION = 1;
    private static final ObjectMapper JSON = new ObjectMapper();

    public enum ImportStatus { IMPORTED, ALREADY_IMPORTED, UNSUPPORTED_PARTIAL }

    public static final class ImportResult {
        public final ImportStatus status;
        public final String packageId;
        public final String archiveSha256;
        ImportResult(ImportStatus status, String packageId, String archiveSha256) {
            this.status = status; this.packageId = packageId; this.archiveSha256 = archiveSha256;
        }
    }

    public static final class StoreException extends Exception {
        public final String code;
        StoreException(String code, String message) { super(message); this.code = code; }
        StoreException(String code, String message, Throwable cause) { super(message, cause); this.code = code; }
    }

    /** Read-only record view. rawJson retains all fields from the source record. */
    public static final class StoredRecord {
        public final String id;
        public final int revision;
        public final String rawJson;
        StoredRecord(String id, int revision, String rawJson) {
            this.id = id; this.revision = revision; this.rawJson = rawJson;
        }
    }

    private final DbHelper helper;

    public WorkPackageStore(Context context, String databaseName) {
        if (databaseName == null || databaseName.trim().isEmpty()) throw new IllegalArgumentException("databaseName required");
        helper = new DbHelper(context.getApplicationContext(), databaseName);
    }

    /** Validates all package bytes before opening a write transaction. */
    public ImportResult importPackage(byte[] archive, String expectedDatasetId) throws StoreException {
        final WorkPackageReader.Result verified;
        try {
            verified = WorkPackageReader.read(archive, expectedDatasetId);
        } catch (WorkPackageReader.PackageException e) {
            throw new StoreException("PACKAGE_REJECTED", "A2 reader rejected the package", e);
        }
        return importVerified(verified, expectedDatasetId);
    }

    /** Imports only A2-validated data; all writes and the receipt share one transaction. */
    public ImportResult importVerified(WorkPackageReader.Result result, String expectedDatasetId) throws StoreException {
        if (result == null || result.manifest == null || result.payload == null) throw new StoreException("INVALID_RESULT", "Verified reader result required");
        JsonNode manifest = result.manifest;
        JsonNode payload = result.payload;
        if (!"TEST".equals(text(manifest, "environment"))) throw new StoreException("ENVIRONMENT", "Only TEST packages are accepted");
        if (!TEST_DATASET.equals(expectedDatasetId) || !TEST_DATASET.equals(text(manifest, "datasetId")))
            throw new StoreException("DATASET", "A3 accepts only the artificial A1 dataset");
        if (!"0.1-test".equals(text(manifest, "contractVersion")) || !manifest.path("schemaVersion").isInt()
                || manifest.path("schemaVersion").asInt() != 1 || !"Kilbid".equals(text(manifest, "module")))
            throw new StoreException("CONTRACT", "Unsupported package contract");
        if (!"WORK_PACKAGE".equals(text(manifest, "packageType"))) throw new StoreException("PACKAGE_TYPE", "A3 imports WORK_PACKAGE only");
        if (!payload.path("fullSnapshot").isBoolean()) throw new StoreException("PAYLOAD", "fullSnapshot required");
        if (!payload.path("fullSnapshot").asBoolean()) return new ImportResult(ImportStatus.UNSUPPORTED_PARTIAL, text(manifest, "packageId"), result.archiveSha256);
        if (!payload.path("baseSnapshotId").isNull()) throw new StoreException("PAYLOAD", "Initial full snapshot must have null baseSnapshotId");
        if (!isSha256(result.archiveSha256)) throw new StoreException("ARCHIVE_HASH", "Invalid archive SHA-256");
        String packageId = text(manifest, "packageId");
        String snapshotId = text(payload, "snapshotId");
        if (empty(packageId) || empty(snapshotId)) throw new StoreException("IDENTITY", "Package and snapshot IDs are required");

        SQLiteDatabase db = helper.getWritableDatabase();
        db.beginTransaction();
        try {
            String storedDataset = querySingle(db, "SELECT dataset_id FROM dataset_lock LIMIT 1", null);
            if (storedDataset != null && !TEST_DATASET.equals(storedDataset)) throw new StoreException("DATASET_LOCKED", "Database belongs to another dataset");
            Cursor prior = db.query("package_receipts", new String[]{"archive_sha256"}, "dataset_id=? AND package_id=?",
                    new String[]{TEST_DATASET, packageId}, null, null, null);
            try {
                if (prior.moveToFirst()) {
                    String oldHash = prior.getString(0);
                    if (!result.archiveSha256.equals(oldHash)) throw new StoreException("PACKAGE_ID_COLLISION", "packageId already exists with another archive hash");
                    db.setTransactionSuccessful();
                    return new ImportResult(ImportStatus.ALREADY_IMPORTED, packageId, result.archiveSha256);
                }
            } finally { prior.close(); }

            if (storedDataset == null) db.insertOrThrow("dataset_lock", null, values("dataset_id", TEST_DATASET));
            insertEntities(db, payload);
            ContentValues receipt = new ContentValues();
            receipt.put("dataset_id", TEST_DATASET);
            receipt.put("package_id", packageId);
            receipt.put("snapshot_id", snapshotId);
            receipt.put("archive_sha256", result.archiveSha256);
            receipt.put("manifest_json", compact(manifest));
            receipt.put("payload_json", compact(payload));
            receipt.put("imported_at_utc", System.currentTimeMillis());
            db.insertOrThrow("package_receipts", null, receipt);
            db.setTransactionSuccessful();
            return new ImportResult(ImportStatus.IMPORTED, packageId, result.archiveSha256);
        } catch (StoreException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new StoreException("IMPORT_ROLLED_BACK", "SQLite import failed and was rolled back", e);
        } finally {
            db.endTransaction();
        }
    }

    private static void insertEntities(SQLiteDatabase db, JsonNode payload) throws StoreException {
        for (JsonNode n : payload.path("cabinets")) insertRecord(db, "cabinets", "kilp_id", text(n, "kilpId"), null, n);
        for (JsonNode n : payload.path("lastInspections")) insertRecord(db, "inspections", "kontroll_id", text(n, "kontrollId"), n, n);
        for (JsonNode n : payload.path("openDefects")) insertRecord(db, "defects", "puudus_id", text(n, "puudusId"), n, n);
        for (JsonNode n : payload.path("repairs")) insertRecord(db, "repairs", "parandus_id", text(n, "parandusId"), n, n);
        for (JsonNode n : payload.path("tasks")) insertRecord(db, "recheck_tasks", "task_id", text(n, "taskId"), n, n);
    }

    private static void insertRecord(SQLiteDatabase db, String table, String idColumn, String id, JsonNode links, JsonNode record) throws StoreException {
        if (empty(id)) throw new StoreException("IDENTITY", "Missing stable entity ID for " + table);
        ContentValues v = new ContentValues();
        v.put("dataset_id", TEST_DATASET);
        v.put(idColumn, id);
        if (links != null) {
            // Only write columns that exist in the corresponding SQLite table.
            switch (table) {
                case "inspections":
                    put(v, "kilp_id", links, "kilpId");
                    break;
                case "defects":
                    put(v, "kilp_id", links, "kilpId");
                    put(v, "kontroll_id", links, "kontrollId");
                    break;
                case "repairs":
                    put(v, "puudus_id", links, "puudusId");
                    break;
                case "recheck_tasks":
                    v.put("type", text(record, "type"));
                    put(v, "kilp_id", links, "kilpId");
                    put(v, "kontroll_id", links, "kontrollId");
                    put(v, "puudus_id", links, "puudusId");
                    put(v, "parandus_id", links, "parandusId");
                    break;
                default:
                    throw new IllegalArgumentException("Unsupported record table: " + table);
            }
        }
        if (record.has("revision") && record.path("revision").canConvertToInt()) v.put("revision", record.path("revision").asInt());
        else v.putNull("revision");
        v.put("raw_json", compact(record));
        try { db.insertOrThrow(table, null, v); }
        catch (SQLException e) { throw new StoreException("ENTITY_ID_COLLISION", "Entity ID already exists or relationship is invalid: " + id, e); }
    }

    private static void put(ContentValues v, String column, JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) v.putNull(column); else v.put(column, value.asText());
    }

    public StoredRecord getCabinet(String id) { return find("cabinets", "kilp_id", id); }
    public StoredRecord getPreviousInspection(String id) { return find("inspections", "kontroll_id", id); }
    public StoredRecord getDefect(String id) { return find("defects", "puudus_id", id); }
    public StoredRecord getRepair(String id) { return find("repairs", "parandus_id", id); }
    public StoredRecord getRecheckTask(String id) { return find("recheck_tasks", "task_id", id); }

    private StoredRecord find(String table, String idColumn, String id) {
        SQLiteDatabase db = helper.getReadableDatabase();
        Cursor c = db.query(table, new String[]{idColumn, "revision", "raw_json"}, "dataset_id=? AND " + idColumn + "=?",
                new String[]{TEST_DATASET, id}, null, null, null);
        try {
            if (!c.moveToFirst()) return null;
            int revision = c.isNull(1) ? -1 : c.getInt(1);
            return new StoredRecord(c.getString(0), revision, c.getString(2));
        } finally { c.close(); }
    }

    public int getReceiptCount() { return count("package_receipts"); }
    public int getCabinetCount() { return count("cabinets"); }
    public int getInspectionCount() { return count("inspections"); }
    public int getDefectCount() { return count("defects"); }
    public int getRepairCount() { return count("repairs"); }
    public int getTaskCount() { return count("recheck_tasks"); }
    private int count(String table) {
        Cursor c = helper.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM " + table + " WHERE dataset_id=?", new String[]{TEST_DATASET});
        try { return c.moveToFirst() ? c.getInt(0) : 0; } finally { c.close(); }
    }

    @Override public void close() { helper.close(); }

    private static String querySingle(SQLiteDatabase db, String sql, String[] args) {
        Cursor c = db.rawQuery(sql, args);
        try { return c.moveToFirst() ? c.getString(0) : null; } finally { c.close(); }
    }
    private static ContentValues values(String key, String value) { ContentValues v = new ContentValues(); v.put(key, value); return v; }
    private static String text(JsonNode n, String key) { JsonNode v = n == null ? null : n.get(key); return v == null || v.isNull() ? null : v.asText(); }
    private static boolean empty(String s) { return s == null || s.trim().isEmpty(); }
    private static boolean isSha256(String s) { return s != null && s.matches("[0-9a-f]{64}"); }
    private static String compact(JsonNode n) {
        try { return JSON.writeValueAsString(n); }
        catch (IOException e) { throw new IllegalStateException("Validated JSON serialization failed", e); }
    }

    private static final class DbHelper extends SQLiteOpenHelper {
        DbHelper(Context context, String name) { super(context, name, null, DB_VERSION); }
        @Override public void onConfigure(SQLiteDatabase db) { super.onConfigure(db); db.setForeignKeyConstraintsEnabled(true); }
        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE dataset_lock(dataset_id TEXT PRIMARY KEY NOT NULL)");
            db.execSQL("CREATE TABLE package_receipts(dataset_id TEXT NOT NULL, package_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, archive_sha256 TEXT NOT NULL, manifest_json TEXT NOT NULL, payload_json TEXT NOT NULL, imported_at_utc INTEGER NOT NULL, PRIMARY KEY(dataset_id, package_id), FOREIGN KEY(dataset_id) REFERENCES dataset_lock(dataset_id))");
            db.execSQL("CREATE TABLE cabinets(dataset_id TEXT NOT NULL, kilp_id TEXT NOT NULL, revision INTEGER, raw_json TEXT NOT NULL, PRIMARY KEY(dataset_id, kilp_id), FOREIGN KEY(dataset_id) REFERENCES dataset_lock(dataset_id))");
            db.execSQL("CREATE TABLE inspections(dataset_id TEXT NOT NULL, kontroll_id TEXT NOT NULL, kilp_id TEXT NOT NULL, revision INTEGER, raw_json TEXT NOT NULL, PRIMARY KEY(dataset_id, kontroll_id), FOREIGN KEY(dataset_id, kilp_id) REFERENCES cabinets(dataset_id, kilp_id))");
            db.execSQL("CREATE TABLE defects(dataset_id TEXT NOT NULL, puudus_id TEXT NOT NULL, kilp_id TEXT NOT NULL, kontroll_id TEXT NOT NULL, revision INTEGER, raw_json TEXT NOT NULL, PRIMARY KEY(dataset_id, puudus_id), FOREIGN KEY(dataset_id, kilp_id) REFERENCES cabinets(dataset_id, kilp_id), FOREIGN KEY(dataset_id, kontroll_id) REFERENCES inspections(dataset_id, kontroll_id))");
            db.execSQL("CREATE TABLE repairs(dataset_id TEXT NOT NULL, parandus_id TEXT NOT NULL, puudus_id TEXT NOT NULL, revision INTEGER, raw_json TEXT NOT NULL, PRIMARY KEY(dataset_id, parandus_id), FOREIGN KEY(dataset_id, puudus_id) REFERENCES defects(dataset_id, puudus_id))");
            db.execSQL("CREATE TABLE recheck_tasks(dataset_id TEXT NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, kilp_id TEXT NOT NULL, kontroll_id TEXT, puudus_id TEXT, parandus_id TEXT, revision INTEGER, raw_json TEXT NOT NULL, PRIMARY KEY(dataset_id, task_id), FOREIGN KEY(dataset_id, kilp_id) REFERENCES cabinets(dataset_id, kilp_id), FOREIGN KEY(dataset_id, kontroll_id) REFERENCES inspections(dataset_id, kontroll_id), FOREIGN KEY(dataset_id, puudus_id) REFERENCES defects(dataset_id, puudus_id), FOREIGN KEY(dataset_id, parandus_id) REFERENCES repairs(dataset_id, parandus_id))");
        }
        @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            throw new SQLiteException("Refusing destructive v2storage migration " + oldVersion + " -> " + newVersion);
        }
    }
}
