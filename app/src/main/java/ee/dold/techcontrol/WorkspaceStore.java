package ee.dold.techcontrol;

import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** One atomic file holds both workbook bytes and current-cycle state.
 * Lives in filesDir, never cacheDir. Acknowledgement follows fsync and atomic rename.
 */
final class WorkspaceStore {
    private final File directory;
    WorkspaceStore(File filesDir) { directory = new File(filesDir, "workspaces-v1"); }
    private File path(String id) throws Exception {
        if (id == null || !id.matches("[a-zA-Z0-9_-]{1,100}")) throw new IOException("Vigane andmebaasi tunnus");
        if (!directory.exists() && !directory.mkdirs()) throw new IOException("Sisemist kausta ei saa luua");
        return new File(directory, id + ".json");
    }
    static String hash(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder out = new StringBuilder();
        for (byte b : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
    synchronized JSONObject read(String id) throws Exception {
        AtomicFile file = new AtomicFile(path(id));
        if (!file.getBaseFile().exists() && !new File(path(id) + ".bak").exists()) return null;
        JSONObject envelope = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
        String payload = envelope.getString("payload");
        if (!hash(payload.getBytes(StandardCharsets.UTF_8)).equals(envelope.getString("sha256")))
            throw new IOException("Salvestatud töö kontrollsumma ei klapi: " + id);
        JSONObject data = new JSONObject(payload);
        if (!id.equals(data.getString("dbId"))) throw new IOException("Andmebaasi tunnus ei klapi");
        return data;
    }
    synchronized void save(String id, String payload) throws Exception {
        JSONObject data = new JSONObject(payload);
        if (data.getInt("schema") != 1 || !id.equals(data.getString("dbId")) || data.getString("workbookBase64").isEmpty())
            throw new IOException("Tööandmed on puudulikud");
        byte[] bytes = new JSONObject().put("payload", payload)
                .put("sha256", hash(payload.getBytes(StandardCharsets.UTF_8)))
                .toString().getBytes(StandardCharsets.UTF_8);
        AtomicFile file = new AtomicFile(path(id));
        FileOutputStream out = null;
        try {
            out = file.startWrite(); out.write(bytes); out.flush(); out.getFD().sync();
            file.finishWrite(out); out = null;
            JSONObject written = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
            if (!written.getString("sha256").equals(hash(payload.getBytes(StandardCharsets.UTF_8))))
                throw new IOException("Salvestamise järelkontroll ebaõnnestus");
            read(id);
        } catch (Exception e) { if (out != null) file.failWrite(out); throw e; }
    }
    synchronized JSONArray list() throws Exception {
        JSONArray result = new JSONArray();
        if (!directory.exists()) return result;
        File[] files = directory.listFiles();
        if (files == null) throw new IOException("Salvestatud töid ei saa lugeda");
        java.util.Set<String> ids = new java.util.TreeSet<>();
        for (File f : files) {
            String n = f.getName();
            if (n.endsWith(".json")) ids.add(n.substring(0,n.length()-5));
            if (n.endsWith(".json.bak")) ids.add(n.substring(0,n.length()-9));
        }
        for (String id : ids) {
            try {
                JSONObject snapshot = read(id);
                if (snapshot == null) continue;
                snapshot.remove("workbookBase64"); snapshot.remove("baseWorkbookBase64"); result.put(snapshot);
            } catch (Exception ignored) {
                // One damaged workspace must not prevent opening a different workbook.
                // The detailed issue remains available through listErrors().
            }
        }
        return result;
    }
    synchronized JSONArray listErrors() throws Exception {
        JSONArray result = new JSONArray();
        if (!directory.exists()) return result;
        File[] files = directory.listFiles();
        if (files == null) throw new IOException("Salvestatud töid ei saa lugeda");
        java.util.Set<String> ids = new java.util.TreeSet<>();
        for (File f : files) {
            String n = f.getName();
            if (n.endsWith(".json")) ids.add(n.substring(0,n.length()-5));
            if (n.endsWith(".json.bak")) ids.add(n.substring(0,n.length()-9));
        }
        for (String id : ids) {
            try { read(id); }
            catch (Exception e) { result.put(new JSONObject().put("id",id).put("error",e.getMessage()==null?e.toString():e.getMessage())); }
        }
        return result;
    }
    static String ok(Object data) {
        try { return new JSONObject().put("ok",true).put("data",data == null ? JSONObject.NULL : data).toString(); }
        catch (Exception e) { return error(e); }
    }
    static String error(Exception e) {
        try { return new JSONObject().put("ok",false).put("error",e.getMessage()==null?e.toString():e.getMessage()).toString(); }
        catch (Exception ignored) { return "{\"ok\":false,\"error\":\"Salvestamine ebaõnnestus\"}"; }
    }
}
