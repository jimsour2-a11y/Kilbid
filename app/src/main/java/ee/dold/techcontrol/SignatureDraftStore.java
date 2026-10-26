package ee.dold.techcontrol;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Durable S1-only drafts. Each single atomic file contains metadata and its PNG together. */
final class SignatureDraftStore {
    private static final int MAGIC = 0x44544353; // DTCS
    private static final int FILE_VERSION = 1;
    private static final int MAX_FILE_BYTES = 24 * 1024 * 1024;
    private static final int MAX_PNG_BYTES = 16 * 1024 * 1024;
    private static final int MAX_STRING_BYTES = 1_048_576;
    private static final int MAX_METADATA_FIELDS = 256;
    private static final int HASH_ASCII_BYTES = 64;
    private final File directory;

    SignatureDraftStore(File filesDir) {
        if (filesDir == null) throw new IllegalArgumentException("filesDir is required");
        this.directory = new File(filesDir, "signature-drafts-s1");
    }

    synchronized boolean containsSignatureId(String signatureId) throws IOException {
        File file = draftFile(signatureId, false);
        return file.exists();
    }

    synchronized SaveResult saveDraft(SignatureCaptureCore.Draft source) throws Exception {
        validateDraft(source);
        ensureDirectory();
        File target = draftFile(source.signatureId, false);
        if (target.exists()) throw new IOException("AllkiriID on telefonis juba kasutusel");

        Registry registry = readRegistry();
        List<String> matches = new ArrayList<>();
        for (SignatureCaptureCore.Draft prior : registry.drafts) {
            if (prior.signatureId.equals(source.signatureId))
                throw new IOException("AllkiriID on telefonis juba kasutusel");
            if (hasExactReuseMatch(source.nonce, source.strokeHash, source.pngHash, source.geometryHash,
                    prior.nonce, prior.strokeHash, prior.pngHash, prior.geometryHash)) {
                matches.add(prior.signatureId);
            }
        }
        if (!matches.isEmpty()) throw new DuplicateCaptureException(matches);

        String result = registry.complete ? "UNIQUE" : "NOT_CHECKED";
        String digest = registry.complete ? registry.digest : "";
        int checkedCount = registry.complete ? registry.drafts.size() : 0;
        long checkedAtUtcMs = registry.complete ? System.currentTimeMillis() : 0L;
        SignatureCaptureCore.Draft acceptedDraft = source.withAntiReuse(result,
                checkedAtUtcMs, checkedCount, digest, Collections.emptyList());
        validateDraft(acceptedDraft);
        byte[] bytes = encodeFile(acceptedDraft);
        if (bytes.length > MAX_FILE_BYTES) throw new IOException("Allkirja mustand on telefoni salvestamiseks liiga suur");
        atomicCreate(target.toPath(), bytes);
        SignatureCaptureCore.Draft verified = readDraft(target);
        return new SaveResult(verified, registry.complete);
    }

    synchronized List<SignatureCaptureCore.Draft> listDrafts() throws IOException {
        Registry registry = readRegistry();
        if (!registry.complete) throw new IOException("Allkirjade kohalik register ei ole täielik");
        return Collections.unmodifiableList(registry.drafts);
    }

    synchronized SignatureCaptureCore.Draft readDraftById(String signatureId) throws IOException {
        File file = draftFile(signatureId, false);
        if (!file.isFile()) throw new IOException("Allkirja telefoni mustandit ei leitud");
        Registry registry = readRegistry();
        if (!registry.complete) throw new IOException("Allkirjade kohalik register ei ole täielik");
        for (SignatureCaptureCore.Draft draft : registry.drafts)
            if (draft.signatureId.equals(signatureId)) return draft;
        throw new IOException("Allkirja telefoni mustandit ei leitud");
    }

    private Registry readRegistry() throws IOException {
        if (!directory.exists()) return new Registry(true, Collections.emptyList(), SignatureCanonicalJson.sha256(SignatureCanonicalJson.bytes(Collections.emptyList())));
        File[] files = directory.listFiles((dir, name) -> name.endsWith(".draft"));
        if (files == null) throw new IOException("Allkirjade kohalikku registrit ei saa lugeda");
        List<File> sortedFiles = new ArrayList<>();
        Collections.addAll(sortedFiles, files);
        sortedFiles.sort(Comparator.comparing(File::getName));
        List<SignatureCaptureCore.Draft> drafts = new ArrayList<>();
        boolean complete = true;
        for (File file : sortedFiles) {
            try {
                SignatureCaptureCore.Draft draft = readDraft(file);
                if (!file.getName().equals(draft.signatureId + ".draft")) throw new IOException("Allkirja mustandi faili nimi ei klapi ID-ga");
                drafts.add(draft);
            } catch (Exception e) {
                complete = false;
            }
        }
        if (!complete) return new Registry(false, drafts, "");
        drafts.sort(Comparator.comparing(d -> d.signatureId));
        List<Map<String, Object>> projection = new ArrayList<>();
        for (SignatureCaptureCore.Draft draft : drafts) projection.add(draft.registryObject());
        String digest = registryDigest(projection);
        return new Registry(true, drafts, digest);
    }

    static String registryDigest(List<Map<String, Object>> entries) {
        String[] fields = {"signatureId", "nonce", "strokeHash", "pngHash", "geometryHash"};
        List<Map<String, Object>> projection = new ArrayList<>();
        for (Map<String, Object> entry : entries) {
            Map<String, Object> row = new LinkedHashMap<>();
            for (String field : fields) row.put(field, entry != null && entry.containsKey(field) ? entry.get(field) : null);
            projection.add(row); // Unknown legacy fields are intentionally excluded.
        }
        projection.sort(Comparator.comparing(row -> String.valueOf(row.get("signatureId"))));
        return SignatureCanonicalJson.sha256(SignatureCanonicalJson.bytes(projection));
    }

    static boolean hasExactReuseMatch(String nonce, String strokeHash, String pngHash, String geometryHash,
                                      String priorNonce, String priorStrokeHash, String priorPngHash, String priorGeometryHash) {
        return nonce.equals(priorNonce) || strokeHash.equals(priorStrokeHash)
                || pngHash.equals(priorPngHash) || geometryHash.equals(priorGeometryHash);
    }

    private void ensureDirectory() throws IOException {
        if (!directory.exists() && !directory.mkdirs() && !directory.isDirectory())
            throw new IOException("Allkirjade kohalikku kausta ei saa luua");
        if (!directory.isDirectory()) throw new IOException("Allkirjade kohalik kaust ei ole kasutatav");
    }

    private File draftFile(String signatureId, boolean createDirectory) throws IOException {
        if (signatureId == null || !signatureId.matches("dtc-sign-[0-9a-fA-F-]{36}"))
            throw new IOException("AllkiriID on vigane");
        if (createDirectory) ensureDirectory();
        return new File(directory, signatureId + ".draft");
    }

    private static void atomicCreate(Path target, byte[] bytes) throws IOException {
        Path directory = target.getParent();
        Path temp = Files.createTempFile(directory, ".signature-draft-", ".tmp");
        boolean moved = false;
        try {
            try (FileOutputStream out = new FileOutputStream(temp.toFile())) {
                out.write(bytes);
                out.flush();
                out.getFD().sync();
            }
            try {
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temp, target);
            }
            moved = true;
        } finally {
            if (!moved) Files.deleteIfExists(temp);
        }
    }

    private static byte[] encodeFile(SignatureCaptureCore.Draft draft) throws IOException {
        ByteArrayOutputStream payloadBytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(payloadBytes)) {
            out.writeInt(draft.schemaVersion);
            writeString(out, draft.status);
            writeString(out, draft.signatureId);
            writeString(out, draft.targetType);
            writeString(out, draft.recordId);
            out.writeBoolean(draft.recordVersion != null);
            if (draft.recordVersion != null) out.writeLong(draft.recordVersion);
            writeString(out, draft.recordVersionSource);
            writeString(out, draft.kilpId);
            writeString(out, draft.signerName);
            writeStringMap(out, draft.targetMetadata);
            writeString(out, draft.nonce);
            out.writeLong(draft.captureStartedAtUtcMs);
            out.writeLong(draft.captureEndedAtUtcMs);
            out.writeLong(draft.captureDurationMs);
            writeString(out, draft.clockSource);
            writeString(out, draft.inputMethod);
            out.writeInt(draft.strokeCount);
            out.writeInt(draft.pointCount);
            out.writeInt(draft.canvasWidthPx);
            out.writeInt(draft.canvasHeightPx);
            out.writeInt(draft.points.size());
            for (SignatureCaptureCore.Point point : draft.points) {
                out.writeInt(point.strokeNr);
                out.writeInt(point.pointNr);
                out.writeInt(point.xNorm);
                out.writeInt(point.yNorm);
                out.writeInt(point.elapsedMs);
            }
            writeBytes(out, draft.pngBytes, MAX_PNG_BYTES);
            writeString(out, draft.pngHash);
            writeString(out, draft.strokeHash);
            writeString(out, draft.geometryHash);
            writeString(out, draft.rendererProfile);
            writeString(out, draft.deviceInstanceId);
            writeString(out, draft.appVersionName);
            out.writeLong(draft.appVersionCode);
            writeString(out, draft.androidRelease);
            out.writeInt(draft.androidApiLevel);
            writeString(out, draft.antiReuseResult);
            writeString(out, draft.antiReuseScope);
            out.writeLong(draft.antiReuseCheckedAtUtcMs);
            out.writeInt(draft.antiReuseCheckedCount);
            writeString(out, draft.antiReuseRegistryDigest);
            out.writeInt(draft.antiReuseMatchingSignatureIds.size());
            for (String id : draft.antiReuseMatchingSignatureIds) writeString(out, id);
        }
        byte[] payload = payloadBytes.toByteArray();
        byte[] payloadHash = SignatureCanonicalJson.sha256(payload).getBytes(StandardCharsets.US_ASCII);
        ByteArrayOutputStream fileBytes = new ByteArrayOutputStream(12 + payload.length + HASH_ASCII_BYTES);
        try (DataOutputStream out = new DataOutputStream(fileBytes)) {
            out.writeInt(MAGIC);
            out.writeInt(FILE_VERSION);
            out.writeInt(payload.length);
            out.write(payload);
            out.write(payloadHash);
        }
        return fileBytes.toByteArray();
    }

    private static SignatureCaptureCore.Draft readDraft(File file) throws IOException {
        long length = file.length();
        if (length < 12 + HASH_ASCII_BYTES || length > MAX_FILE_BYTES) throw new IOException("Allkirja mustandi faili suurus on vigane");
        byte[] bytes = new byte[(int) length];
        try (FileInputStream in = new FileInputStream(file)) { readFully(in, bytes); }
        try (DataInputStream fileIn = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (fileIn.readInt() != MAGIC || fileIn.readInt() != FILE_VERSION) throw new IOException("Allkirja mustandi vormingut ei tunta");
            int payloadLength = fileIn.readInt();
            if (payloadLength < 0 || payloadLength != bytes.length - 12 - HASH_ASCII_BYTES) throw new IOException("Allkirja mustandi pikkus ei klapi");
            byte[] payload = new byte[payloadLength];
            fileIn.readFully(payload);
            byte[] expectedHash = new byte[HASH_ASCII_BYTES];
            fileIn.readFully(expectedHash);
            if (fileIn.read() != -1 || !SignatureCanonicalJson.sha256(payload).equals(new String(expectedHash, StandardCharsets.US_ASCII)))
                throw new IOException("Allkirja mustandi kontrollsumma ei klapi");
            return decodeDraft(payload);
        } catch (RuntimeException e) {
            throw new IOException("Allkirja mustandi sisu on vigane", e);
        }
    }

    private static SignatureCaptureCore.Draft decodeDraft(byte[] payload) throws IOException {
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(payload))) {
            int schema = in.readInt();
            if (schema != 1) throw new IOException("Allkirja mustandi skeemi ei tunta");
            String status = readString(in);
            String signatureId = readString(in);
            String targetType = readString(in);
            String recordId = readString(in);
            Long recordVersion = in.readBoolean() ? in.readLong() : null;
            String recordVersionSource = readString(in);
            String kilpId = readString(in);
            String signerName = readString(in);
            Map<String, String> targetMetadata = readStringMap(in);
            String nonce = readString(in);
            long startedAt = in.readLong();
            long endedAt = in.readLong();
            long duration = in.readLong();
            String clockSource = readString(in);
            String inputMethod = readString(in);
            int strokeCount = in.readInt();
            int pointCount = in.readInt();
            int width = in.readInt();
            int height = in.readInt();
            int count = in.readInt();
            if (count < 0 || count > SignatureCaptureCore.MAX_POINTS || count != pointCount) throw new IOException("Allkirja punktide arv on vigane");
            List<SignatureCaptureCore.Point> points = new ArrayList<>(count);
            for (int i = 0; i < count; i++) points.add(new SignatureCaptureCore.Point(in.readInt(), in.readInt(), in.readInt(), in.readInt(), in.readInt()));
            byte[] png = readBytes(in, MAX_PNG_BYTES);
            String pngHash = readString(in);
            String strokeHash = readString(in);
            String geometryHash = readString(in);
            String rendererProfile = readString(in);
            String deviceInstanceId = readString(in);
            String appVersionName = readString(in);
            long appVersionCode = in.readLong();
            String androidRelease = readString(in);
            int androidApiLevel = in.readInt();
            String antiReuseResult = readString(in);
            String antiReuseScope = readString(in);
            long checkedAt = in.readLong();
            int checkedCount = in.readInt();
            String registryDigest = readString(in);
            int matchCount = in.readInt();
            if (matchCount < 0 || matchCount > 100_000) throw new IOException("Allkirjade korduskasutuse vasteid on liiga palju");
            List<String> matches = new ArrayList<>(matchCount);
            for (int i = 0; i < matchCount; i++) matches.add(readString(in));
            if (in.read() != -1) throw new IOException("Allkirja mustandis on tundmatuid andmeid");

            SignatureCaptureCore.Target target = new SignatureCaptureCore.Target(targetType, recordId, kilpId,
                    signerName, recordVersion, recordVersionSource, targetMetadata);
            SignatureCaptureCore.DeviceInfo device = new SignatureCaptureCore.DeviceInfo(deviceInstanceId,
                    appVersionName, appVersionCode, androidRelease, androidApiLevel);
            SignatureCaptureCore.Draft draft = new SignatureCaptureCore.Draft(status, signatureId, target, nonce,
                    startedAt, endedAt, duration, points, strokeCount, width, height, png, pngHash,
                    strokeHash, geometryHash, device, antiReuseResult, checkedAt, checkedCount,
                    registryDigest, matches, rendererProfile);
            if (!SignatureCaptureCore.CLOCK_SOURCE.equals(clockSource) || !SignatureCaptureCore.INPUT_METHOD.equals(inputMethod)
                    || !SignatureCaptureCore.isSupportedRendererProfile(rendererProfile))
                throw new IOException("Allkirja mustandi metaandmed ei klapi S1 vorminguga");
            validateDraft(draft);
            return draft;
        } catch (IllegalArgumentException e) {
            throw new IOException("Allkirja mustandi siht või metaandmed on vigased", e);
        }
    }

    private static void validateDraft(SignatureCaptureCore.Draft draft) throws IOException {
        if (draft == null || !SignatureCaptureCore.DRAFT_STATUS.equals(draft.status)) throw new IOException("Allkirja mustand ei ole S1 mustand");
        if (draft.signatureId == null || !draft.signatureId.matches("dtc-sign-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"))
            throw new IOException("AllkiriID ei ole UUIDv4");
        if (draft.nonce == null || !draft.nonce.matches("[0-9a-f]{64}")) throw new IOException("Allkirja nonce on vigane");
        if (draft.canvasWidthPx < 2 || draft.canvasHeightPx < 2 || (long) draft.canvasWidthPx * draft.canvasHeightPx > 4_000_000L)
            throw new IOException("Allkirja canvas mõõtmed on vigased");
        if (draft.points.isEmpty() || draft.pointCount != draft.points.size() || draft.strokeCount < 1)
            throw new IOException("Allkirja puutepunktid puuduvad");
        if (draft.captureEndedAtUtcMs < draft.captureStartedAtUtcMs || draft.captureDurationMs < 0)
            throw new IOException("Allkirja aeg on vigane");
        int expectedStroke = 1, expectedPoint = 1, lastElapsed = -1;
        java.util.Set<String> positions = new java.util.HashSet<>();
        for (int i = 0; i < draft.points.size(); i++) {
            SignatureCaptureCore.Point point = draft.points.get(i);
            if (point.strokeNr != expectedStroke || point.pointNr != expectedPoint || point.xNorm < 0 || point.xNorm > 1_000_000
                    || point.yNorm < 0 || point.yNorm > 1_000_000 || point.elapsedMs < 0 || point.elapsedMs < lastElapsed
                    || point.elapsedMs > draft.captureDurationMs) throw new IOException("Allkirja punktide järjekord või väärtus on vigane");
            lastElapsed = point.elapsedMs;
            positions.add(point.xNorm + ":" + point.yNorm);
            if (i + 1 < draft.points.size() && draft.points.get(i + 1).strokeNr != expectedStroke) {
                if (draft.points.get(i + 1).strokeNr != expectedStroke + 1) throw new IOException("Allkirja joonte järjekord on vigane");
                expectedStroke++;
                expectedPoint = 1;
            } else {
                if (expectedPoint == Integer.MAX_VALUE) throw new IOException("Allkirja joone punktide arv on vigane");
                expectedPoint++;
            }
        }
        if (expectedStroke != draft.strokeCount || positions.size() < 2) throw new IOException("Allkirja joonte arv või geomeetria on vigane");
        if (!SignatureCanonicalJson.sha256(draft.pngBytes).equals(draft.pngHash)) throw new IOException("Allkirja PNG kontrollsumma ei klapi");
        if (!SignatureCanonicalJson.sha256(SignatureCanonicalJson.bytes(draft.strokesObject())).equals(draft.strokeHash))
            throw new IOException("Allkirja stroke hash ei klapi");
        List<SignatureCaptureCore.Point> points = draft.points;
        if (!SignatureCanonicalJson.sha256(SignatureCanonicalJson.bytes(SignatureCaptureCore.geometryObject(points))).equals(draft.geometryHash))
            throw new IOException("Allkirja geomeetria hash ei klapi");
        if (!isPng(draft.pngBytes)) throw new IOException("Allkirja PNG ei ole loetav PNG konteiner");
        if (!SignatureCaptureCore.isSupportedRendererProfile(draft.rendererProfile)) throw new IOException("Allkirja renderdusprofiili ei tunta");
        if (!"UNIQUE".equals(draft.antiReuseResult) && !"NOT_CHECKED".equals(draft.antiReuseResult)) throw new IOException("Allkirja korduskasutuse tulemus on vigane");
        if (!SignatureCaptureCore.ANTI_REUSE_SCOPE.equals(draft.antiReuseScope)) throw new IOException("Allkirja korduskasutuse ulatus on vigane");
        if ("UNIQUE".equals(draft.antiReuseResult) && (draft.antiReuseRegistryDigest == null || !draft.antiReuseRegistryDigest.matches("[0-9a-f]{64}")))
            throw new IOException("Allkirjade kohaliku registri hash puudub");
        if ("NOT_CHECKED".equals(draft.antiReuseResult) && !draft.antiReuseRegistryDigest.isEmpty()) throw new IOException("Kontrollimata registril ei tohi olla kinnitatud hash-i");
    }

    private static boolean isPng(byte[] value) {
        return value != null && value.length >= 24 && value[0] == (byte) 137 && value[1] == 80 && value[2] == 78
                && value[3] == 71 && value[4] == 13 && value[5] == 10 && value[6] == 26 && value[7] == 10;
    }

    private static void writeString(DataOutputStream out, String value) throws IOException {
        byte[] bytes = (value == null ? "" : value).getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_STRING_BYTES) throw new IOException("Allkirja tekstiväli on liiga suur");
        out.writeInt(bytes.length);
        out.write(bytes);
    }

    private static String readString(DataInputStream in) throws IOException {
        int length = in.readInt();
        if (length < 0 || length > MAX_STRING_BYTES) throw new IOException("Allkirja tekstivälja pikkus on vigane");
        byte[] bytes = new byte[length];
        in.readFully(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private static void writeStringMap(DataOutputStream out, Map<String, String> values) throws IOException {
        if (values.size() > MAX_METADATA_FIELDS) throw new IOException("Allkirja sihtmetaandmeid on liiga palju");
        List<String> keys = new ArrayList<>(values.keySet());
        Collections.sort(keys);
        out.writeInt(keys.size());
        for (String key : keys) { writeString(out, key); writeString(out, values.get(key)); }
    }

    private static Map<String, String> readStringMap(DataInputStream in) throws IOException {
        int count = in.readInt();
        if (count < 0 || count > MAX_METADATA_FIELDS) throw new IOException("Allkirja sihtmetaandmete arv on vigane");
        Map<String, String> values = new LinkedHashMap<>();
        for (int i = 0; i < count; i++) {
            String key = readString(in), value = readString(in);
            if (values.put(key, value) != null) throw new IOException("Allkirja sihtmetaandmes kordub");
        }
        return values;
    }

    private static void writeBytes(DataOutputStream out, byte[] bytes, int max) throws IOException {
        if (bytes == null || bytes.length > max) throw new IOException("Allkirja PNG on liiga suur");
        out.writeInt(bytes.length);
        out.write(bytes);
    }

    private static byte[] readBytes(DataInputStream in, int max) throws IOException {
        int count = in.readInt();
        if (count <= 0 || count > max) throw new IOException("Allkirja PNG suurus on vigane");
        byte[] bytes = new byte[count];
        in.readFully(bytes);
        return bytes;
    }

    private static void readFully(FileInputStream in, byte[] target) throws IOException {
        int offset = 0;
        while (offset < target.length) {
            int count = in.read(target, offset, target.length - offset);
            if (count < 0) throw new IOException("Allkirja mustand jäi pooleli");
            offset += count;
        }
        if (in.read() != -1) throw new IOException("Allkirja mustandi failis on lisabaite");
    }

    static final class SaveResult {
        final SignatureCaptureCore.Draft draft;
        final boolean registryChecked;
        SaveResult(SignatureCaptureCore.Draft draft, boolean registryChecked) { this.draft = draft; this.registryChecked = registryChecked; }
    }

    static final class DuplicateCaptureException extends IOException {
        final List<String> matchingSignatureIds;
        DuplicateCaptureException(List<String> ids) {
            super("Allkirja joonistus kordub telefoni teadaolevas registris");
            List<String> sorted = new ArrayList<>(ids);
            Collections.sort(sorted);
            this.matchingSignatureIds = Collections.unmodifiableList(sorted);
        }
    }

    private static final class Registry {
        final boolean complete;
        final List<SignatureCaptureCore.Draft> drafts;
        final String digest;
        Registry(boolean complete, List<SignatureCaptureCore.Draft> drafts, String digest) {
            this.complete = complete; this.drafts = drafts; this.digest = digest;
        }
    }
}
