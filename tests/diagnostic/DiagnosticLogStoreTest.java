package ee.dold.techcontrol;

import java.io.File;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;

public final class DiagnosticLogStoreTest {
    private static int passed;

    public static void main(String[] args) throws Exception {
        File root = Files.createTempDirectory("dold-diagnostic-test").toFile();
        try {
            appendAndOrder(new File(root, "append"));
            persistence(new File(root, "persist"));
            rotation(new File(root, "rotate"));
            clear(new File(root, "clear"));
            secretFiltering(new File(root, "security"));
            stats(new File(root, "stats"));
            System.out.println("DIAGNOSTIC_LOG_STORE PASS " + passed + "/6");
        } finally {
            deleteTree(root);
        }
    }

    private static void appendAndOrder(File dir) throws Exception {
        DiagnosticLogStore store = new DiagnosticLogStore(new File(dir, "diagnostic.log"), 8192);
        store.append("INFO", "APP", "STARTUP", Map.of("api", 35));
        store.append("WARN", "LAN", "CHUNK_RETRY", Map.of("transfer", "abc123", "chunk", "2/8", "attempt", 2));
        String text = store.readAll();
        require(text.matches("(?s)\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3}] INFO APP STARTUP.*"), "timestamp/format");
        require(text.indexOf("STARTUP") < text.indexOf("CHUNK_RETRY"), "append order");
        pass("append/read/order");
    }

    private static void persistence(File dir) throws Exception {
        DiagnosticLogStore first = new DiagnosticLogStore(new File(dir, "diagnostic.log"), 8192);
        first.append("INFO", "WORKSPACE", "SAVE_SUCCESS", Map.of("revision", 7));
        DiagnosticLogStore restarted = new DiagnosticLogStore(new File(dir, "diagnostic.log"), 8192);
        require(restarted.readAll().contains("SAVE_SUCCESS revision=7"), "restart persistence");
        pass("persistence");
    }

    private static void rotation(File dir) throws Exception {
        DiagnosticLogStore store = new DiagnosticLogStore(new File(dir, "diagnostic.log"), 2048);
        for (int i = 0; i < 150; i++) store.append("INFO", "LAN", "CHUNK_RX", Map.of("sequence", i, "payload", "x".repeat(40)));
        String text = store.readAll();
        require(store.sizeBytes() <= 2048, "bounded size");
        require(text.contains("sequence=149"), "newest entry retained");
        require(!text.contains("sequence=0 "), "oldest entry rotated");
        pass("rotation/bound");
    }

    private static void clear(File dir) throws Exception {
        DiagnosticLogStore store = new DiagnosticLogStore(new File(dir, "diagnostic.log"), 8192);
        store.append("ERROR", "XLSX", "IMPORT_FAILED", Map.of("code", "IMPORT_FAILED"));
        store.clear();
        String text = store.readAll();
        require(!text.contains("IMPORT_FAILED"), "old entries removed");
        require(text.contains("INFO APP LOG_CLEARED"), "clear marker");
        pass("clear/marker");
    }

    private static void secretFiltering(File dir) throws Exception {
        DiagnosticLogStore store = new DiagnosticLogStore(new File(dir, "diagnostic.log"), 8192);
        Map<String,Object> fields = new LinkedHashMap<>();
        fields.put("token", "super-secret-token");fields.put("hmacKey", "private-key");fields.put("nonce", "signature-nonce");
        fields.put("rawStrokeCoordinates", "1,2,3");fields.put("pngBase64", "iVBORw0KGgo");fields.put("proofJson", "{secret:true}");
        fields.put("message", "authToken=also-secret safe error");fields.put("pointCount", 243);
        store.append("ERROR", "SIGNATURE", "VALIDATION_FAILED", fields);
        String text = store.readAll();
        for (String forbidden : new String[]{"super-secret-token","private-key","signature-nonce","1,2,3","iVBORw0KGgo","{secret:true}","also-secret"})
            require(!text.contains(forbidden), "secret leaked: " + forbidden);
        require(text.contains("pointCount=243"), "safe count retained");
        require(text.contains("[REDACTED]"), "redaction marker");
        pass("secret filtering");
    }

    private static void stats(File dir) throws Exception {
        DiagnosticLogStore store = new DiagnosticLogStore(new File(dir, "diagnostic.log"), 8192);
        store.append("INFO", "SYNC", "APPLY", Map.of("applied", 4, "duplicates", 2, "conflicts", 0));
        require(store.entryCount() == 1, "entry count");
        require(store.sizeBytes() > 0, "size");
        require(store.lastEventTime().matches("\\d{4}-\\d{2}-\\d{2} .*"), "last event time");
        pass("stats");
    }

    private static void pass(String name) { passed++;System.out.println("PASS " + name); }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static void deleteTree(File file) { if (file == null || !file.exists()) return;if (file.isDirectory()) { File[] children=file.listFiles();if(children!=null)for(File child:children)deleteTree(child); }file.delete(); }
}
