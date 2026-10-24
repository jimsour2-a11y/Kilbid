package ee.dold.techcontrol;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/** Small RFC 8785 subset for the integer/string/array/object values used by S1 hashes. */
final class SignatureCanonicalJson {
    private SignatureCanonicalJson() {}

    static byte[] bytes(Object value) {
        return stringify(value).getBytes(StandardCharsets.UTF_8);
    }

    static String stringify(Object value) {
        StringBuilder out = new StringBuilder();
        append(out, value);
        return out.toString();
    }

    static String sha256(byte[] value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
            StringBuilder out = new StringBuilder(64);
            for (byte b : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            return out.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private static void append(StringBuilder out, Object value) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String) {
            quote(out, (String) value);
        } else if (value instanceof Boolean) {
            out.append(((Boolean) value) ? "true" : "false");
        } else if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long) {
            out.append(value.toString());
        } else if (value instanceof Map) {
            appendMap(out, (Map<?, ?>) value);
        } else if (value instanceof Iterable) {
            appendIterable(out, (Iterable<?>) value);
        } else if (value.getClass().isArray()) {
            int length = java.lang.reflect.Array.getLength(value);
            out.append('[');
            for (int i = 0; i < length; i++) {
                if (i > 0) out.append(',');
                append(out, java.lang.reflect.Array.get(value, i));
            }
            out.append(']');
        } else {
            throw new IllegalArgumentException("Unsupported canonical JSON value: " + value.getClass().getName());
        }
    }

    private static void appendMap(StringBuilder out, Map<?, ?> map) {
        List<String> keys = new ArrayList<>();
        for (Object key : map.keySet()) {
            if (!(key instanceof String)) throw new IllegalArgumentException("Canonical JSON object keys must be strings");
            keys.add((String) key);
        }
        Collections.sort(keys, Comparator.naturalOrder()); // Java compares UTF-16 code units as required by JCS.
        out.append('{');
        for (int i = 0; i < keys.size(); i++) {
            if (i > 0) out.append(',');
            String key = keys.get(i);
            quote(out, key);
            out.append(':');
            append(out, map.get(key));
        }
        out.append('}');
    }

    private static void appendIterable(StringBuilder out, Iterable<?> values) {
        out.append('[');
        boolean first = true;
        for (Object value : values) {
            if (!first) out.append(',');
            first = false;
            append(out, value);
        }
        out.append(']');
    }

    private static void quote(StringBuilder out, String value) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\t': out.append("\\t"); break;
                case '\n': out.append("\\n"); break;
                case '\f': out.append("\\f"); break;
                case '\r': out.append("\\r"); break;
                default:
                    if (c < 0x20) {
                        out.append("\\u00");
                        out.append(Character.forDigit((c >>> 4) & 0xf, 16));
                        out.append(Character.forDigit(c & 0xf, 16));
                    } else if (Character.isHighSurrogate(c)) {
                        if (i + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(i + 1)))
                            throw new IllegalArgumentException("Unpaired high surrogate in canonical JSON string");
                        out.append(c).append(value.charAt(++i));
                    } else if (Character.isLowSurrogate(c)) {
                        throw new IllegalArgumentException("Unpaired low surrogate in canonical JSON string");
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
    }
}
