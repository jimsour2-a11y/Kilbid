package ee.dold.techcontrol;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Persistent, bounded and privacy-filtered technical diagnostic log. */
public final class DiagnosticLogStore {
    public static final int MAX_BYTES = 1_572_864;
    private static final String FILE_NAME = "diagnostic.log";
    private static final Pattern SAFE_WORD = Pattern.compile("[A-Za-z0-9._:/@+\\-]{1,256}");
    private static final Pattern SECRET_IN_TEXT = Pattern.compile(
            "(?i)(qr[_-]?token|auth(?:entication)?[_-]?token|hmac(?:[_-]?(?:secret|key))?|secret|signature[_-]?nonce|nonce)\\s*[:=]\\s*([^\\s,;]+)");

    private final File file;
    private final int maxBytes;

    public DiagnosticLogStore(File filesDir) throws IOException {
        this(new File(filesDir, FILE_NAME), MAX_BYTES);
    }

    DiagnosticLogStore(File file, int maxBytes) throws IOException {
        if (file == null || maxBytes < 1024) throw new IllegalArgumentException("Invalid diagnostic log storage");
        this.file = file;
        this.maxBytes = maxBytes;
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("Diagnostic directory unavailable");
        if (!file.exists() && !file.createNewFile()) throw new IOException("Diagnostic log unavailable");
    }

    public synchronized void append(String level, String component, String event, Map<String, ?> fields) throws IOException {
        String line = formatTimestamp(System.currentTimeMillis()) + " " + normalizeWord(level, "INFO") + " "
                + normalizeWord(component, "APP") + " " + normalizeWord(event, "EVENT") + formatFields(fields) + "\n";
        byte[] bytes = line.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > maxBytes) {
            line = line.substring(0, Math.min(line.length(), 512)) + " truncated=true\n";
            bytes = line.getBytes(StandardCharsets.UTF_8);
        }
        if (file.length() + bytes.length > maxBytes) rotateFor(bytes.length);
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write(bytes);
            out.flush();
            out.getFD().sync();
        }
    }

    public synchronized String readAll() throws IOException {
        try (FileInputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) >= 0) out.write(buffer, 0, count);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    public synchronized void clear() throws IOException {
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            out.getFD().sync();
        }
        append("INFO", "APP", "LOG_CLEARED", null);
    }

    public synchronized long sizeBytes() {
        return file.length();
    }

    public synchronized int entryCount() throws IOException {
        String text = readAll();
        if (text.isEmpty()) return 0;
        int count = 0;
        for (int i = 0; i < text.length(); i++) if (text.charAt(i) == '\n') count++;
        return count + (text.endsWith("\n") ? 0 : 1);
    }

    public synchronized String lastEventTime() throws IOException {
        String text = readAll().trim();
        if (text.isEmpty()) return "";
        int start = text.lastIndexOf('\n') + 1;
        String line = text.substring(start);
        int close = line.indexOf(']');
        return line.startsWith("[") && close > 1 ? line.substring(1, close) : "";
    }

    private void rotateFor(int incomingBytes) throws IOException {
        String text = readAll();
        String[] lines = text.split("(?<=\\n)");
        List<byte[]> retained = new ArrayList<>();
        int budget = Math.max(0, maxBytes - incomingBytes);
        int used = 0;
        for (int i = lines.length - 1; i >= 0; i--) {
            byte[] bytes = lines[i].getBytes(StandardCharsets.UTF_8);
            if (used + bytes.length > budget) break;
            retained.add(0, bytes);
            used += bytes.length;
        }
        File temp = new File(file.getParentFile(), file.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp, false)) {
            for (byte[] bytes : retained) out.write(bytes);
            out.flush();
            out.getFD().sync();
        }
        if (file.exists() && !file.delete()) throw new IOException("Old diagnostic log could not be rotated");
        if (!temp.renameTo(file)) throw new IOException("Diagnostic log rotation failed");
    }

    private static String formatTimestamp(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("[yyyy-MM-dd HH:mm:ss.SSS]", Locale.ROOT);
        format.setTimeZone(TimeZone.getDefault());
        return format.format(new Date(millis));
    }

    private static String normalizeWord(String value, String fallback) {
        String normalized = value == null ? "" : value.trim().toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9_]", "_");
        return normalized.isEmpty() ? fallback : normalized.substring(0, Math.min(normalized.length(), 64));
    }

    private static String formatFields(Map<String, ?> fields) {
        if (fields == null || fields.isEmpty()) return "";
        StringBuilder out = new StringBuilder();
        for (Map.Entry<String, ?> entry : new LinkedHashMap<>(fields).entrySet()) {
            String key = entry.getKey() == null ? "field" : entry.getKey().trim().replaceAll("[^A-Za-z0-9_.-]", "_");
            if (key.isEmpty()) key = "field";
            if (key.length() > 64) key = key.substring(0, 64);
            String value = isSensitiveKey(key) ? "[REDACTED]" : sanitizeValue(String.valueOf(entry.getValue()));
            out.append(' ').append(key).append('=').append(quoteValue(value));
        }
        return out.toString();
    }

    private static boolean isSensitiveKey(String key) {
        String value = key.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
        return value.contains("token") || value.contains("hmac") || value.contains("secret")
                || value.contains("nonce") || value.contains("rawstroke") || value.equals("strokes")
                || value.contains("pngbase64") || value.contains("proofjson") || value.contains("workbookcontent");
    }

    private static String sanitizeValue(String value) {
        String safe = value == null ? "" : value.replace('\r', ' ').replace('\n', ' ').replace('\t', ' ')
                .replaceAll("[\\p{Cntrl}&&[^ ]]+", " ").trim();
        Matcher matcher = SECRET_IN_TEXT.matcher(safe);
        StringBuffer filtered = new StringBuffer();
        while (matcher.find()) matcher.appendReplacement(filtered, Matcher.quoteReplacement(matcher.group(1) + "=[REDACTED]"));
        matcher.appendTail(filtered);
        safe = filtered.toString();
        return safe.length() > 512 ? safe.substring(0, 512) + "…" : safe;
    }

    private static String quoteValue(String value) {
        if (SAFE_WORD.matcher(value).matches()) return value;
        return '"' + value.replace("\\", "\\\\").replace("\"", "\\\"") + '"';
    }
}
