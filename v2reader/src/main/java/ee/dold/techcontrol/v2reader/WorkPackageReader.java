package ee.dold.techcontrol.v2reader;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CodingErrorAction;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Isolated, read-only TEST 0.1 WORK_PACKAGE reader. No Android v1 references or database I/O. */
public final class WorkPackageReader {
    public static final int MAX_ARCHIVE = 50 * 1024 * 1024;
    private static final int MAX_JSON = 4 * 1024 * 1024;
    private static final int MAX_ASSET = 20 * 1024 * 1024;
    private static final int MAX_ENTRIES = 1000;
    private static final ObjectMapper JSON = new ObjectMapper(
            JsonFactory.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build());

    private WorkPackageReader() {}

    public static final class PackageException extends Exception {
        public final String code;
        public PackageException(String code, String message) { super(message); this.code = code; }
        public PackageException(String code, String message, Throwable cause) { super(message, cause); this.code = code; }
    }

    public static final class Result {
        public final JsonNode manifest;
        public final JsonNode payload;
        public final String archiveSha256;
        private Result(JsonNode manifest, JsonNode payload, String archiveSha256) {
            this.manifest = manifest.deepCopy();
            this.payload = payload.deepCopy();
            this.archiveSha256 = archiveSha256;
        }
    }

    /** No persistence: returns validated, in-memory JSON data only. */
    public static Result read(byte[] raw, String expectedDatasetId) throws PackageException {
        require(raw != null && raw.length <= MAX_ARCHIVE, "ARCHIVE_LIMIT", "Archive size exceeds TEST limit");
        require(nonempty(expectedDatasetId), "DATASET_REQUIRED", "Expected datasetId is required");
        try {
            Map<String, EntryInfo> central = readCentralDirectory(raw);
            Map<String, byte[]> entries = inflate(raw, central);
            require(entries.containsKey("manifest.json") && entries.containsKey("payload.json"),
                    "MANDATORY_ENTRY", "manifest.json and payload.json required");
            JsonNode manifest = parseJson(entries.get("manifest.json"));
            require(manifest.isObject(), "MANIFEST", "manifest must be an object");
            require(manifest.path("schemaVersion").isIntegralNumber() && manifest.path("schemaVersion").asInt() == 1
                    && str(manifest, "contractVersion").equals("0.1-test")
                    && str(manifest, "module").equals("Kilbid"), "CONTRACT", "Unsupported TEST contract");
            require("TEST".equals(str(manifest, "environment")), "ENVIRONMENT", "Only TEST accepted");
            require(expectedDatasetId.equals(str(manifest, "datasetId")), "DATASET", "Dataset mismatch");
            require(nonempty(str(manifest, "packageId")) && nonempty(str(manifest, "senderDeviceId")),
                    "MANIFEST", "Missing package or device ID");
            require(manifest.path("senderPersonId").isNull() || nonempty(str(manifest, "senderPersonId")),
                    "MANIFEST", "Invalid senderPersonId");
            utc(str(manifest, "createdAtUtc"));
            String type = str(manifest, "packageType");
            require(type.equals("WORK_PACKAGE") || type.equals("CHANGE_PACKAGE") || type.equals("ACK_PACKAGE"),
                    "PACKAGE_TYPE", "Unknown package type");
            require("payload.json".equals(str(manifest, "payloadPath")), "MANIFEST", "Invalid payload path");
            JsonNode files = manifest.path("files");
            require(files.isArray(), "INVENTORY", "files must be an array");
            Set<String> inventoried = new HashSet<>();
            for (JsonNode file : files) {
                require(file.isObject(), "INVENTORY", "Invalid inventory record");
                String path = str(file, "path");
                checkPath(path);
                require(!"manifest.json".equals(path) && inventoried.add(path) && entries.containsKey(path),
                        "INVENTORY", "Duplicate or missing inventory path");
                byte[] content = entries.get(path);
                require(file.path("byteLength").isIntegralNumber()
                        && file.path("byteLength").asLong() == content.length
                        && sha256(content).equals(str(file, "sha256")),
                        "FILE_HASH", "Inventory size or SHA-256 mismatch");
            }
            Set<String> expectedFiles = new HashSet<>(entries.keySet());
            expectedFiles.remove("manifest.json");
            require(inventoried.equals(expectedFiles), "INVENTORY", "Unlisted or missing ZIP entry");
            if (!"WORK_PACKAGE".equals(type)) {
                throw new PackageException("UNSUPPORTED_IN_A2", "CHANGE/ACK business validation not implemented in A2");
            }
            JsonNode payload = parseJson(entries.get("payload.json"));
            validateWork(payload);
            return new Result(manifest, payload, sha256(raw));
        } catch (PackageException e) {
            throw e;
        } catch (IOException | RuntimeException e) {
            throw new PackageException("ZIP_OR_JSON", "Invalid .dtcpkg", e);
        }
    }

    private static JsonNode parseJson(byte[] data) throws PackageException {
        try {
            // Reject malformed UTF-8 rather than silently substituting replacement characters.
            String decoded = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(data)).toString();
            try (JsonParser parser = JSON.getFactory().createParser(decoded)) {
                JsonNode node = JSON.readTree(parser);
                require(node != null && parser.nextToken() == null, "JSON", "Invalid or trailing JSON");
                return node;
            }
        } catch (IOException e) {
            throw new PackageException("JSON", "Invalid UTF-8 JSON", e);
        }
    }

    private static final class EntryInfo {
        final String name;
        final int method;
        final long size;
        final long crc;
        EntryInfo(String name, int method, long size, long crc) {
            this.name = name; this.method = method; this.size = size; this.crc = crc;
        }
    }

    /** Read ZIP central-directory Unix attributes before inflation to reject symlinks safely. */
    private static Map<String, EntryInfo> readCentralDirectory(byte[] raw) throws PackageException {
        require(raw.length >= 22, "ZIP", "Truncated ZIP");
        ByteBuffer b = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
        int eocd = -1;
        for (int i = raw.length - 22; i >= Math.max(0, raw.length - 65557); i--) {
            if (b.getInt(i) == 0x06054b50 && i + 22 + u16(b, i + 20) == raw.length) {
                eocd = i; break;
            }
        }
        require(eocd >= 0, "ZIP", "Missing ZIP central directory");
        require(u16(b, eocd + 4) == 0 && u16(b, eocd + 6) == 0, "ZIP", "Multi-disk ZIP unsupported");
        int onDisk = u16(b, eocd + 8);
        int count = u16(b, eocd + 10);
        long dirSize = u32(b, eocd + 12), dirOffset = u32(b, eocd + 16);
        require(count <= MAX_ENTRIES && onDisk == count && count != 65535
                && dirSize != 0xffffffffL && dirOffset != 0xffffffffL,
                "ZIP", "Unsupported ZIP entry count/ZIP64");
        require(dirOffset + dirSize == eocd, "ZIP", "Unexpected central directory offsets");
        Map<String, EntryInfo> map = new LinkedHashMap<>();
        int pos = (int) dirOffset;
        for (int i = 0; i < count; i++) {
            require(pos <= eocd - 46 && b.getInt(pos) == 0x02014b50, "ZIP", "Invalid central entry");
            int flags = u16(b, pos + 8), method = u16(b, pos + 10);
            long crc = u32(b, pos + 16), size = u32(b, pos + 24);
            int nameLen = u16(b, pos + 28), extraLen = u16(b, pos + 30), commentLen = u16(b, pos + 32);
            long mode = u32(b, pos + 38) >>> 16;
            long localOffset = u32(b, pos + 42);
            int total = 46 + nameLen + extraLen + commentLen;
            require(nameLen > 0 && pos + total <= eocd && localOffset < dirOffset,
                    "ZIP", "Invalid central record offsets");
            require((flags & 1) == 0 && (method == 0 || method == 8), "ZIP", "Encrypted/unsupported ZIP entry");
            require((mode & 0170000) != 0120000, "ZIP", "Symlink rejected");
            require(size != 0xffffffffL, "ZIP", "ZIP64 entry unsupported");
            String name;
            try {
                name = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                        .decode(ByteBuffer.wrap(raw, pos + 46, nameLen)).toString();
            } catch (CharacterCodingException e) {
                throw new PackageException("ZIP", "Invalid entry name", e);
            }
            checkPath(name);
            require(size <= (name.endsWith(".json") ? MAX_JSON : MAX_ASSET),
                    "ZIP_LIMIT", "Entry exceeds TEST size limit");
            require(!map.containsKey(name), "ZIP", "Duplicate ZIP entry");
            map.put(name, new EntryInfo(name, method, size, crc));
            pos += total;
        }
        require(pos == eocd, "ZIP", "Unexpected central directory bytes");
        return map;
    }

    private static Map<String, byte[]> inflate(byte[] raw, Map<String, EntryInfo> central) throws IOException, PackageException {
        Map<String, byte[]> contents = new LinkedHashMap<>();
        int totalUncompressed = 0;
        try (ZipInputStream input = new ZipInputStream(new ByteArrayInputStream(raw), StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
                String name = entry.getName();
                checkPath(name);
                EntryInfo info = central.get(name);
                require(info != null && !contents.containsKey(name) && entry.getMethod() == info.method
                        && !entry.isDirectory(), "ZIP", "Unexpected local ZIP entry");
                int max = name.endsWith(".json") ? MAX_JSON : MAX_ASSET;
                byte[] data = readLimited(input, max);
                require(data.length == info.size, "ZIP", "Central/local ZIP size mismatch");
                java.util.zip.CRC32 crc = new java.util.zip.CRC32(); crc.update(data);
                require(crc.getValue() == info.crc, "ZIP", "ZIP CRC mismatch");
                totalUncompressed += data.length;
                require(totalUncompressed <= MAX_ARCHIVE, "ZIP_LIMIT", "Inflated data exceeds TEST limit");
                contents.put(name, data);
                input.closeEntry();
            }
        }
        require(contents.keySet().equals(central.keySet()), "ZIP", "Missing local ZIP entry");
        return contents;
    }

    private static byte[] readLimited(InputStream in, int max) throws IOException, PackageException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = in.read(buffer)) != -1) {
            require(out.size() + (long) count <= max, "ZIP_LIMIT", "Inflated file exceeds TEST limit");
            out.write(buffer, 0, count);
        }
        return out.toByteArray();
    }

    private static void checkPath(String path) throws PackageException {
        require(path != null && !path.isEmpty() && !path.startsWith("/")
                && !path.contains("\\") && !path.contains("\u0000")
                && !path.matches("^[A-Za-z]:.*"), "ZIP_PATH", "Invalid ZIP path");
        for (String part : path.split("/", -1)) {
            require(!part.isEmpty() && !part.equals(".") && !part.equals(".."),
                    "ZIP_PATH", "Forbidden ZIP path segment");
        }
    }

    private static void validateWork(JsonNode p) throws PackageException {
        require(p.isObject(), "PAYLOAD", "WORK payload object required");
        require(nonempty(str(p, "snapshotId")) && p.path("fullSnapshot").isBoolean()
                && p.path("scope").isObject(), "PAYLOAD", "Invalid WORK header");
        require(p.path("fullSnapshot").asBoolean() ? p.path("baseSnapshotId").isNull()
                        : nonempty(str(p, "baseSnapshotId")), "PAYLOAD", "Invalid baseSnapshotId");
        for (String key : Arrays.asList("cabinets", "lastInspections", "openDefects", "repairs", "tasks")) {
            require(p.path(key).isArray(), "PAYLOAD", "WORK array required: " + key);
        }
        Set<String> cabinets = new HashSet<>(), inspections = new HashSet<>(), defects = new HashSet<>(), repairs = new HashSet<>();
        Map<String, String> inspectionCabinet = new HashMap<>(), defectInspection = new HashMap<>(), defectCabinet = new HashMap<>(), repairDefect = new HashMap<>();
        Set<String> tasks = new HashSet<>();
        for (JsonNode c : p.path("cabinets")) {
            for (String field : Arrays.asList("kilpId", "name", "area", "location", "equipment", "usageStatus"))
                require(nonempty(str(c, field)), "CABINET", "Missing cabinet " + field);
            require(c.has("revision") && cabinets.add(str(c, "kilpId")), "CABINET", "Duplicate/invalid cabinet");
        }
        for (JsonNode i : p.path("lastInspections")) {
            require(nonempty(str(i, "kontrollId")) && nonempty(str(i, "kilpId"))
                    && nonempty(str(i, "inspectorPersonId")) && i.has("scores") && i.has("remarks")
                    && i.has("revision"), "INSPECTION", "Invalid inspection");
            utc(str(i, "dateUtc"));
            String id = str(i, "kontrollId"), cabinet = str(i, "kilpId");
            require(cabinets.contains(cabinet) && inspections.add(id), "INSPECTION", "Invalid inspection link");
            inspectionCabinet.put(id, cabinet);
        }
        for (JsonNode d : p.path("openDefects")) {
            String id = str(d, "puudusId"), inspection = str(d, "kontrollId"), cabinet = str(d, "kilpId");
            require(nonempty(id) && nonempty(inspection) && nonempty(cabinet)
                    && nonempty(str(d, "description")) && nonempty(str(d, "status"))
                    && Arrays.asList("A", "B", "C", "D").contains(str(d, "severity"))
                    && d.has("revision"), "DEFECT", "Invalid defect");
            require(defects.add(id) && cabinets.contains(cabinet) && inspections.contains(inspection)
                    && cabinet.equals(inspectionCabinet.get(inspection)), "DEFECT", "Invalid defect link");
            defectInspection.put(id, inspection); defectCabinet.put(id, cabinet);
        }
        for (JsonNode r : p.path("repairs")) {
            String id = str(r, "parandusId"), defect = str(r, "puudusId");
            require(nonempty(id) && nonempty(defect) && nonempty(str(r, "actorPersonId"))
                    && nonempty(str(r, "workDone")) && nonempty(str(r, "status")), "REPAIR", "Invalid repair");
            utc(str(r, "dateUtc"));
            require(repairs.add(id) && defects.contains(defect), "REPAIR", "Invalid repair link");
            repairDefect.put(id, defect);
        }
        for (JsonNode t : p.path("tasks")) {
            String type = str(t, "type"), cabinet = str(t, "kilpId");
            require(nonempty(str(t, "taskId")) && tasks.add(str(t, "taskId"))
                    && Arrays.asList("INSPECTION", "REPAIR", "RECHECK").contains(type)
                    && cabinets.contains(cabinet), "TASK", "Invalid task");
            if ("RECHECK".equals(type)) {
                String inspection = str(t, "kontrollId"), defect = str(t, "puudusId"), repair = str(t, "parandusId");
                require(inspections.contains(inspection) && defects.contains(defect) && repairs.contains(repair)
                        && cabinet.equals(inspectionCabinet.get(inspection))
                        && inspection.equals(defectInspection.get(defect))
                        && cabinet.equals(defectCabinet.get(defect))
                        && defect.equals(repairDefect.get(repair)), "TASK", "Broken recheck link");
            }
        }
    }

    private static String str(JsonNode n, String key) {
        JsonNode v = n.path(key);
        return v.isTextual() ? v.asText() : "";
    }
    private static boolean nonempty(String value) { return value != null && !value.trim().isEmpty(); }
    private static void require(boolean predicate, String code, String reason) throws PackageException {
        if (!predicate) throw new PackageException(code, reason);
    }
    private static void utc(String value) throws PackageException {
        require(value != null && value.endsWith("Z"), "TIME", "UTC Z timestamp required");
        try { OffsetDateTime.parse(value); } catch (RuntimeException e) {
            throw new PackageException("TIME", "Invalid UTC timestamp", e);
        }
    }
    private static int u16(ByteBuffer b, int p) { return Short.toUnsignedInt(b.getShort(p)); }
    private static long u32(ByteBuffer b, int p) { return Integer.toUnsignedLong(b.getInt(p)); }
    private static String sha256(byte[] data) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(data);
            StringBuilder out = new StringBuilder(64);
            for (byte item : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", item & 255));
            return out.toString();
        } catch (NoSuchAlgorithmException e) { throw new AssertionError("SHA-256 missing", e); }
    }
}
