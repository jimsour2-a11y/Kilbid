package ee.dold.techcontrol;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** S1 touch-session model. It has no XLSX or semantic-sync write path. */
final class SignatureCaptureCore {
    static final String STROKE_FORMAT = "dold-strokes/v1";
    static final String GEOMETRY_FORMAT = "dold-geometry/v1";
    static final String CLOCK_SOURCE = "DEVICE_WALL_CLOCK_UNTRUSTED";
    static final String INPUT_METHOD = "TOUCH";
    static final String DRAFT_STATUS = "S1_DRAFT";
    static final String ANTI_REUSE_SCOPE = "LOCAL_KNOWN_DATA";
    static final String ANTI_REUSE_ALGORITHM = "dold-exact-reuse/v1";
    static final String KONTROLL_RECORD_VERSION_SOURCE = "KONTROLL_SNAPSHOT_METADATA_V1";
    static final String LEGACY_EXPERIMENTAL_RENDERER_PROFILE = "dold-s1-experimental-raster-v1;white-rgba;black-round-2pct;png-deflate-6";
    static final String RENDERER_PROFILE = SignaturePngRenderer.PROFILE;
    static final int MAX_POINTS = 250_000;
    private static final long WALL_CLOCK_TOLERANCE_MS = 5_000L;
    private static final SecureRandom RANDOM = new SecureRandom();

    private SignatureCaptureCore() {}

    static boolean isSupportedRendererProfile(String profile) {
        return RENDERER_PROFILE.equals(profile) || LEGACY_EXPERIMENTAL_RENDERER_PROFILE.equals(profile);
    }

    interface SignatureIdLookup { boolean exists(String signatureId) throws Exception; }

    static final class Target {
        final String targetType;
        final String recordId;
        final String kilpId;
        final String signerName;
        final Long recordVersion;
        final String recordVersionSource;
        final Map<String, String> metadata;

        Target(String targetType, String recordId, String kilpId, String signerName,
               Long recordVersion, String recordVersionSource, Map<String, String> metadata) {
            this.targetType = clean(targetType);
            this.recordId = clean(recordId);
            this.kilpId = clean(kilpId);
            this.signerName = clean(signerName);
            this.recordVersionSource = clean(recordVersionSource);
            this.recordVersion = recordVersion;
            Map<String, String> copy = new LinkedHashMap<>();
            if (metadata != null) {
                List<String> keys = new ArrayList<>(metadata.keySet());
                Collections.sort(keys);
                for (String key : keys) {
                    if (key == null || key.trim().isEmpty()) continue;
                    String value = metadata.get(key);
                    if (value != null) copy.put(key, value);
                }
            }
            this.metadata = Collections.unmodifiableMap(copy);
            validate();
        }

        private void validate() {
            if (!targetType.matches("[A-Za-z][A-Za-z0-9_-]{0,63}"))
                throw new IllegalArgumentException("Allkirja sihtkirje liik on vigane");
            if ("Kontroll".equals(targetType) && !recordId.matches("dtc-kontroll-[A-Za-z0-9_-]{1,180}"))
                throw new IllegalArgumentException("Kontrollil puudub olemasolev püsiv KontrollID");
            if ("Parandus".equals(targetType) && !recordId.matches("dtc-work-[A-Za-z0-9_-]{1,180}"))
                throw new IllegalArgumentException("Parandusel puudub olemasolev püsiv ParandusID");
            if (!"Kontroll".equals(targetType) && !"Parandus".equals(targetType)
                    && !recordId.matches("dtc-[A-Za-z0-9_-]{1,180}"))
                throw new IllegalArgumentException("Sihtkirjel puudub olemasolev püsiv ID");
            if (recordVersion == null) {
                if (!"UNRESOLVED".equals(recordVersionSource)) throw new IllegalArgumentException("Lahendamata kirje versiooni allikas on vigane");
            } else {
                if (recordVersion < 1) throw new IllegalArgumentException("Kirje versioon peab olema positiivne või lahendamata");
                String expectedSource = "Kontroll".equals(targetType) ? KONTROLL_RECORD_VERSION_SOURCE
                        : "Parandus".equals(targetType) ? "PARANDUSED_L" : "";
                if (recordVersionSource.isEmpty() || (!expectedSource.isEmpty() && !expectedSource.equals(recordVersionSource)))
                    throw new IllegalArgumentException("Kirje versiooni allikas ei vasta sihtkirje liigile");
            }
            if (kilpId.isEmpty() || kilpId.length() > 180 || !kilpId.matches("[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}"))
                throw new IllegalArgumentException("Allkirja sihtobjekti ID on vigane");
            if (("Kontroll".equals(targetType) || "Parandus".equals(targetType)) && !kilpId.matches("EK-[0-9]{3,}"))
                throw new IllegalArgumentException("Allkirja sihtkilbi ID on vigane");
            if (recordId.equals(kilpId)) throw new IllegalArgumentException("Allkirja siht peab olema kirje ID, mitte ainult EK ID");
            if (signerName.isEmpty()) throw new IllegalArgumentException("Sisesta allkirjastaja nimi");
        }

        private static String clean(String value) { return value == null ? "" : value.trim(); }
    }

    static final class DeviceInfo {
        final String deviceInstanceId;
        final String appVersionName;
        final long appVersionCode;
        final String androidRelease;
        final int androidApiLevel;
        final String inputMethod;

        DeviceInfo(String deviceInstanceId, String appVersionName, long appVersionCode,
                   String androidRelease, int androidApiLevel) {
            this.deviceInstanceId = deviceInstanceId == null ? "" : deviceInstanceId.trim();
            this.appVersionName = appVersionName == null ? "" : appVersionName.trim();
            this.appVersionCode = appVersionCode;
            this.androidRelease = androidRelease == null ? "" : androidRelease.trim();
            this.androidApiLevel = androidApiLevel;
            this.inputMethod = INPUT_METHOD;
            if (!this.deviceInstanceId.matches("device-[a-f0-9]{32}"))
                throw new IllegalArgumentException("Telefoni püsiv DOLD seadme ID puudub");
        }
    }

    static final class Identity {
        final String signatureId;
        final String nonce;
        Identity(String signatureId, String nonce) { this.signatureId = signatureId; this.nonce = nonce; }
    }

    static Identity newIdentity(SignatureIdLookup lookup) throws Exception {
        for (int attempt = 0; attempt < 16; attempt++) {
            String signatureId = "dtc-sign-" + UUID.randomUUID().toString();
            byte[] nonce = new byte[32];
            RANDOM.nextBytes(nonce);
            String nonceHex = hex(nonce);
            if (lookup == null || !lookup.exists(signatureId)) return new Identity(signatureId, nonceHex);
        }
        throw new IllegalStateException("Unikaalset AllkiriID-d ei saanud luua");
    }

    static Session newSession(Target target, DeviceInfo device, long startedAtUtcMs,
                              long startedElapsedRealtimeMs, SignatureIdLookup lookup) throws Exception {
        return new Session(target, device, newIdentity(lookup), startedAtUtcMs, startedElapsedRealtimeMs);
    }

    static final class Point {
        final int strokeNr;
        final int pointNr;
        final int xNorm;
        final int yNorm;
        final int elapsedMs;
        Point(int strokeNr, int pointNr, int xNorm, int yNorm, int elapsedMs) {
            this.strokeNr = strokeNr;
            this.pointNr = pointNr;
            this.xNorm = xNorm;
            this.yNorm = yNorm;
            this.elapsedMs = elapsedMs;
        }
        List<Integer> strokeTuple() { return Arrays.asList(strokeNr, pointNr, xNorm, yNorm, elapsedMs); }
        List<Integer> geometryTuple() { return Arrays.asList(strokeNr, pointNr, xNorm, yNorm); }
    }

    static final class Draft {
        final int schemaVersion;
        final String status;
        final String signatureId;
        final String targetType;
        final String recordId;
        final Long recordVersion;
        final String recordVersionSource;
        final String kilpId;
        final String signerName;
        final Map<String, String> targetMetadata;
        final String nonce;
        final long captureStartedAtUtcMs;
        final long captureEndedAtUtcMs;
        final long captureDurationMs;
        final String clockSource;
        final String inputMethod;
        final List<Point> points;
        final int strokeCount;
        final int pointCount;
        final int canvasWidthPx;
        final int canvasHeightPx;
        final byte[] pngBytes;
        final String pngHash;
        final String strokeHash;
        final String geometryHash;
        final String rendererProfile;
        final String deviceInstanceId;
        final String appVersionName;
        final long appVersionCode;
        final String androidRelease;
        final int androidApiLevel;
        final String antiReuseResult;
        final String antiReuseScope;
        final long antiReuseCheckedAtUtcMs;
        final int antiReuseCheckedCount;
        final String antiReuseRegistryDigest;
        final List<String> antiReuseMatchingSignatureIds;

        Draft(String status, String signatureId, Target target, String nonce,
              long startUtc, long endUtc, long duration, List<Point> points,
              int strokeCount, int width, int height, byte[] png, String pngHash,
              String strokeHash, String geometryHash, DeviceInfo device,
              String antiReuseResult, long checkedAt, int checkedCount,
              String registryDigest, List<String> matches) {
            this(status, signatureId, target, nonce, startUtc, endUtc, duration, points, strokeCount,
                    width, height, png, pngHash, strokeHash, geometryHash, device, antiReuseResult,
                    checkedAt, checkedCount, registryDigest, matches, RENDERER_PROFILE);
        }

        Draft(String status, String signatureId, Target target, String nonce,
              long startUtc, long endUtc, long duration, List<Point> points,
              int strokeCount, int width, int height, byte[] png, String pngHash,
              String strokeHash, String geometryHash, DeviceInfo device,
              String antiReuseResult, long checkedAt, int checkedCount,
              String registryDigest, List<String> matches, String rendererProfile) {
            this.schemaVersion = 1;
            this.status = status;
            this.signatureId = signatureId;
            this.targetType = target.targetType;
            this.recordId = target.recordId;
            this.recordVersion = target.recordVersion;
            this.recordVersionSource = target.recordVersionSource;
            this.kilpId = target.kilpId;
            this.signerName = target.signerName;
            this.targetMetadata = Collections.unmodifiableMap(new LinkedHashMap<>(target.metadata));
            this.nonce = nonce;
            this.captureStartedAtUtcMs = startUtc;
            this.captureEndedAtUtcMs = endUtc;
            this.captureDurationMs = duration;
            this.clockSource = CLOCK_SOURCE;
            this.inputMethod = device.inputMethod;
            this.points = Collections.unmodifiableList(new ArrayList<>(points));
            this.strokeCount = strokeCount;
            this.pointCount = points.size();
            this.canvasWidthPx = width;
            this.canvasHeightPx = height;
            this.pngBytes = png.clone();
            this.pngHash = pngHash;
            this.strokeHash = strokeHash;
            this.geometryHash = geometryHash;
            this.rendererProfile = rendererProfile;
            this.deviceInstanceId = device.deviceInstanceId;
            this.appVersionName = device.appVersionName;
            this.appVersionCode = device.appVersionCode;
            this.androidRelease = device.androidRelease;
            this.androidApiLevel = device.androidApiLevel;
            this.antiReuseResult = antiReuseResult;
            this.antiReuseScope = ANTI_REUSE_SCOPE;
            this.antiReuseCheckedAtUtcMs = checkedAt;
            this.antiReuseCheckedCount = checkedCount;
            this.antiReuseRegistryDigest = registryDigest == null ? "" : registryDigest;
            List<String> sorted = new ArrayList<>(matches == null ? Collections.emptyList() : matches);
            Collections.sort(sorted);
            this.antiReuseMatchingSignatureIds = Collections.unmodifiableList(sorted);
        }

        Draft withAntiReuse(String result, long checkedAt, int checkedCount, String digest, List<String> matches) {
            Target target = new Target(targetType, recordId, kilpId, signerName, recordVersion, recordVersionSource, targetMetadata);
            DeviceInfo device = new DeviceInfo(deviceInstanceId, appVersionName, appVersionCode, androidRelease, androidApiLevel);
            return new Draft(status, signatureId, target, nonce, captureStartedAtUtcMs, captureEndedAtUtcMs,
                    captureDurationMs, points, strokeCount, canvasWidthPx, canvasHeightPx, pngBytes, pngHash,
                    strokeHash, geometryHash, device, result, checkedAt, checkedCount, digest, matches, rendererProfile);
        }

        Map<String, Object> strokesObject() {
            Map<String, Object> object = new LinkedHashMap<>();
            object.put("format", STROKE_FORMAT);
            object.put("canvasWidthPx", canvasWidthPx);
            object.put("canvasHeightPx", canvasHeightPx);
            List<List<Integer>> tuples = new ArrayList<>();
            for (Point p : points) tuples.add(p.strokeTuple());
            object.put("points", tuples);
            return object;
        }

        Map<String, Object> registryObject() {
            Map<String, Object> object = new LinkedHashMap<>();
            object.put("signatureId", signatureId);
            object.put("nonce", nonce);
            object.put("strokeHash", strokeHash);
            object.put("pngHash", pngHash);
            object.put("geometryHash", geometryHash);
            return object;
        }
    }

    static final class Session {
        final Target target;
        final DeviceInfo device;
        final String signatureId;
        final String nonce;
        final long captureStartedAtUtcMs;
        final long startedElapsedRealtimeMs;
        private final List<List<Point>> completedStrokes = new ArrayList<>();
        private List<Point> activeStroke;
        private int width;
        private int height;
        private int lastElapsedMs;
        private int totalPointCount;
        private boolean cancelled;

        Session(Target target, DeviceInfo device, Identity identity, long startedAtUtcMs, long startedElapsedRealtimeMs) {
            if (target == null || device == null || identity == null) throw new IllegalArgumentException("Allkirja sessiooni andmed puuduvad");
            this.target = target;
            this.device = device;
            this.signatureId = identity.signatureId;
            this.nonce = identity.nonce;
            this.captureStartedAtUtcMs = startedAtUtcMs;
            this.startedElapsedRealtimeMs = startedElapsedRealtimeMs;
        }

        boolean setCanvasSize(int newWidth, int newHeight) {
            ensureActive();
            if (newWidth < 2 || newHeight < 2) throw new IllegalArgumentException("Allkirja ala on liiga väike");
            if (width > 0 && height > 0 && (width != newWidth || height != newHeight)) {
                cancelled = true;
                activeStroke = null;
                completedStrokes.clear();
                return false;
            }
            width = newWidth;
            height = newHeight;
            return true;
        }

        void beginStroke(float x, float y, long elapsedRealtimeMs) {
            ensureReady();
            if (activeStroke != null) throw new IllegalStateException("Eelmine joon pole lõppenud");
            activeStroke = new ArrayList<>();
            addPoint(x, y, elapsedRealtimeMs);
        }

        void addPoint(float x, float y, long elapsedRealtimeMs) {
            ensureReady();
            if (activeStroke == null) throw new IllegalStateException("Joonistamine ei ole alanud");
            if (totalPointCount >= MAX_POINTS)
                throw new IllegalStateException("Allkirjas on liiga palju punkte. Alusta uut allkirja.");
            int elapsed = elapsed(elapsedRealtimeMs);
            float clampedX = Math.max(0f, Math.min(x, width - 1f));
            float clampedY = Math.max(0f, Math.min(y, height - 1f));
            int xNorm = normalize(clampedX, width);
            int yNorm = normalize(clampedY, height);
            int strokeNr = completedStrokes.size() + 1;
            activeStroke.add(new Point(strokeNr, activeStroke.size() + 1, xNorm, yNorm, elapsed));
            totalPointCount++;
        }

        void endStroke(float x, float y, long elapsedRealtimeMs) {
            addPoint(x, y, elapsedRealtimeMs);
            if (activeStroke == null || activeStroke.isEmpty()) throw new IllegalStateException("Tühja joont ei saa lõpetada");
            completedStrokes.add(activeStroke);
            activeStroke = null;
        }

        /** ACTION_CANCEL discards the unfinished stroke and never completes it. */
        void cancelCurrentStroke() {
            ensureActive();
            if (activeStroke != null) totalPointCount -= activeStroke.size();
            activeStroke = null;
        }

        void cancelCapture() {
            cancelled = true;
            activeStroke = null;
            completedStrokes.clear();
            totalPointCount = 0;
        }

        boolean isCancelled() { return cancelled; }
        boolean hasActiveStroke() { return activeStroke != null; }
        int strokeCount() { return completedStrokes.size(); }
        int pointCount() { return totalPointCount; }

        List<List<Point>> previewStrokes() {
            List<List<Point>> result = new ArrayList<>();
            for (List<Point> stroke : completedStrokes) result.add(Collections.unmodifiableList(stroke));
            if (activeStroke != null) result.add(Collections.unmodifiableList(activeStroke));
            return Collections.unmodifiableList(result);
        }

        Draft finish(long endedAtUtcMs, long endedElapsedRealtimeMs) throws CaptureException {
            ensureReady();
            if (activeStroke != null) throw new CaptureException("STROKE_IN_PROGRESS", "Tõsta enne kinnitamist sõrm ekraanilt.");
            long duration = endedElapsedRealtimeMs - startedElapsedRealtimeMs;
            if (duration < 0 || duration > Integer.MAX_VALUE)
                throw new CaptureException("CLOCK_INCONSISTENT", "Seadme monotoonne kellaaeg on vigane. Alusta uuesti.");
            long wallDuration = endedAtUtcMs - captureStartedAtUtcMs;
            if (wallDuration < 0 || absoluteDifference(wallDuration, duration) > WALL_CLOCK_TOLERANCE_MS)
                throw new CaptureException("CLOCK_INCONSISTENT", "Seadme kellaaeg muutus allkirjastamise ajal. Alusta uuesti.");
            if (completedStrokes.isEmpty()) throw new CaptureException("STROKES_MISSING", "Joonista allkiri enne kinnitamist.");
            List<Point> points = new ArrayList<>();
            Set<String> positions = new LinkedHashSet<>();
            for (int i = 0; i < completedStrokes.size(); i++) {
                List<Point> stroke = completedStrokes.get(i);
                if (stroke.isEmpty()) throw new CaptureException("STROKES_INVALID", "Allkirja joon sisaldab tühja joont.");
                for (int j = 0; j < stroke.size(); j++) {
                    Point p = stroke.get(j);
                    if (p.strokeNr != i + 1 || p.pointNr != j + 1 || p.elapsedMs < 0 || p.xNorm < 0 || p.xNorm > 1_000_000 || p.yNorm < 0 || p.yNorm > 1_000_000)
                        throw new CaptureException("STROKES_INVALID", "Allkirja puutepunktid on vigased.");
                    points.add(p);
                    positions.add(p.xNorm + ":" + p.yNorm);
                }
            }
            if (points.isEmpty()) throw new CaptureException("STROKES_MISSING", "Joonista allkiri enne kinnitamist.");
            if (positions.size() < 2) throw new CaptureException("STROKES_TOO_SHORT", "Allkiri peab sisaldama vähemalt kahte erinevat punkti.");
            if (points.get(points.size() - 1).elapsedMs > duration)
                throw new CaptureException("CLOCK_INCONSISTENT", "Allkirja punktide aeg ei klapi sessiooni kestusega.");

            Map<String, Object> strokes = strokeObject(width, height, points);
            Map<String, Object> geometry = geometryObject(points);
            byte[] png = SignaturePngRenderer.renderCanonical(points);
            String pngHash = SignatureCanonicalJson.sha256(png);
            String strokeHash = SignatureCanonicalJson.sha256(SignatureCanonicalJson.bytes(strokes));
            String geometryHash = SignatureCanonicalJson.sha256(SignatureCanonicalJson.bytes(geometry));
            return new Draft(DRAFT_STATUS, signatureId, target, nonce, captureStartedAtUtcMs, endedAtUtcMs,
                    duration, points, completedStrokes.size(), width, height, png, pngHash, strokeHash,
                    geometryHash, device, "NOT_CHECKED", endedAtUtcMs, 0, "", Collections.emptyList());
        }

        private int elapsed(long now) {
            long value = now - startedElapsedRealtimeMs;
            if (value < 0 || value > Integer.MAX_VALUE) throw new IllegalStateException("Seadme monotoonne kellaaeg on vigane");
            int result = (int) value;
            if (result < lastElapsedMs) throw new IllegalStateException("Puutepunktide aeg ei liigu edasi");
            lastElapsedMs = result;
            return result;
        }

        private void ensureActive() {
            if (cancelled) throw new IllegalStateException("Allkirjastamise sessioon on tühistatud");
        }
        private void ensureReady() {
            ensureActive();
            if (width < 2 || height < 2) throw new IllegalStateException("Allkirja ala pole valmis");
        }
    }

    static final class CaptureException extends Exception {
        final String code;
        CaptureException(String code, String message) { super(message); this.code = code; }
    }

    static Map<String, Object> strokeObject(int width, int height, List<Point> points) {
        Map<String, Object> object = new LinkedHashMap<>();
        object.put("format", STROKE_FORMAT);
        object.put("canvasWidthPx", width);
        object.put("canvasHeightPx", height);
        List<List<Integer>> tuples = new ArrayList<>();
        for (Point point : points) tuples.add(point.strokeTuple());
        object.put("points", tuples);
        return object;
    }

    static Map<String, Object> geometryObject(List<Point> points) {
        Map<String, Object> object = new LinkedHashMap<>();
        object.put("format", GEOMETRY_FORMAT);
        List<List<Integer>> tuples = new ArrayList<>();
        for (Point point : points) tuples.add(point.geometryTuple());
        object.put("points", tuples);
        return object;
    }

    static int normalize(float coordinate, int dimension) {
        if (dimension < 2) throw new IllegalArgumentException("Canvas dimensions must be at least 2 px");
        double value = Math.max(0d, Math.min(coordinate, dimension - 1d));
        return (int) Math.floor(1_000_000d * value / (dimension - 1d) + 0.5d);
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }

    private static long absoluteDifference(long a, long b) {
        if (a >= b) return a - b;
        return b - a;
    }
}
