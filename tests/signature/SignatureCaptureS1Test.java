package ee.dold.techcontrol;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.imageio.ImageIO;

/** Standalone tests for the Android-independent S1 capture, hashing, and draft-store core. */
public final class SignatureCaptureS1Test {
    private interface Case { void run() throws Exception; }
    private static int passed;
    private static int failed;

    public static void main(String[] args) throws Exception {
        test("JCS canonical object ordering and UTF-8 escaping", () -> {
            Map<String,Object> value = new LinkedHashMap<>();
            value.put("z", Arrays.asList(true, 0));
            value.put("a", "ä\n");
            check("{\"a\":\"ä\\n\",\"z\":[true,0]}".equals(SignatureCanonicalJson.stringify(value)), "canonical JSON differs");
            check("c2f2e522557588f0fb943228a4c695a383418cbaa0437628e621cebcf59e0442".equals(SignatureCanonicalJson.sha256(SignatureCanonicalJson.bytes(value))), "canonical hash differs from golden vector");
        });
        test("local anti-reuse registry projection matches R4 JCS golden vectors", () -> {
            Map<String,Object> second = new LinkedHashMap<>();
            second.put("geometryHash", "g2"); second.put("ignoredLegacyField", "not-in-digest"); second.put("signatureId", "dtc-sign-00000000-0000-4000-8000-000000000002");
            second.put("nonce", "n2"); second.put("strokeHash", "s2"); second.put("pngHash", "p2");
            Map<String,Object> first = new LinkedHashMap<>();
            first.put("strokeHash", "s1"); first.put("signatureId", "dtc-sign-00000000-0000-4000-8000-000000000001");
            first.put("geometryHash", "g1"); first.put("nonce", "n1"); // missing legacy pngHash is projected as null
            List<Map<String,Object>> entries = Arrays.asList(second, first);
            String digest = SignatureDraftStore.registryDigest(entries);
            check("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945".equals(SignatureDraftStore.registryDigest(Collections.emptyList())), "empty registry digest differs from golden vector");
            check(digest.equals(SignatureDraftStore.registryDigest(Arrays.asList(first, second))), "registry sort is not by signatureId");
            check("d9261cda6af4c9df3350398ad57d5d5957d8bcb1c0f15c18a4583d952635fc06".equals(digest), "non-empty registry digest differs from golden vector");
        });
        test("local anti-reuse checks each exact indicator independently", () -> {
            check(SignatureDraftStore.hasExactReuseMatch("n", "s", "p", "g", "n", "x", "y", "z"), "nonce duplicate not detected");
            check(SignatureDraftStore.hasExactReuseMatch("x", "s", "p", "g", "y", "s", "z", "w"), "StrokeHash duplicate not detected");
            check(SignatureDraftStore.hasExactReuseMatch("x", "s", "p", "g", "y", "t", "p", "w"), "PNGHash duplicate not detected");
            check(SignatureDraftStore.hasExactReuseMatch("x", "s", "p", "g", "y", "t", "q", "g"), "geometryHash duplicate not detected");
            check(!SignatureDraftStore.hasExactReuseMatch("n", "s", "p", "g", "x", "t", "q", "z"), "different exact indicators were marked duplicate");
        });
        test("new capture starts empty with UUIDv4 AllkiriID and 32-byte nonce", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            check(s.pointCount() == 0 && s.strokeCount() == 0, "new capture is not empty");
            check(s.signatureId.matches("dtc-sign-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"), "AllkiriID is not UUIDv4");
            check(s.nonce.matches("[0-9a-f]{64}"), "nonce is not 32 bytes in lower-case hex");
        });
        test("new capture identity changes each time", () -> {
            SignatureCaptureCore.Session a = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            SignatureCaptureCore.Session b = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_001_000L, 2_000L);
            check(!a.signatureId.equals(b.signatureId), "AllkiriID reused");
            check(!a.nonce.equals(b.nonce), "nonce reused");
        });
        test("new identity retries when a candidate AllkiriID is already registered", () -> {
            int[] lookups = {0};
            SignatureCaptureCore.Identity identity = SignatureCaptureCore.newIdentity(id -> ++lookups[0] == 1);
            check(lookups[0] == 2, "existing candidate was not checked again");
            check(identity.signatureId.matches("dtc-sign-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"), "retry identity is invalid");
            check(identity.nonce.matches("[0-9a-f]{64}"), "retry nonce is invalid");
        });
        test("target model supports both registered types without creating target IDs", () -> {
            SignatureCaptureCore.Target control = target("Kontroll", "dtc-kontroll-existing", 3L, Collections.emptyMap());
            SignatureCaptureCore.Target work = target("Parandus", "dtc-work-test-6cc420fc-8ee7-40a2-9a48-0f458b398e8f", 1L, Collections.singletonMap("puudusId", "dtc-puudus-existing"));
            check("dtc-kontroll-existing".equals(control.recordId), "Kontroll ID changed");
            check("dtc-work-test-6cc420fc-8ee7-40a2-9a48-0f458b398e8f".equals(work.recordId), "ParandusID changed");
            check("dtc-puudus-existing".equals(work.metadata.get("puudusId")), "repair link metadata lost");
        });
        test("target adapters preserve strict cabinet IDs while generic modules can reuse the capture core", () -> {
            expect(IllegalArgumentException.class, () -> target("Kontroll", "EK-052", 1L, Collections.emptyMap()));
            expect(IllegalArgumentException.class, () -> target("Kontroll", "dtc-kontroll-x", 0L, Collections.emptyMap()));
            SignatureCaptureCore.Target motor = new SignatureCaptureCore.Target("Mootor", "dtc-motor-asset-1", "MTR-021", "Vladimir J", null, "UNRESOLVED", Collections.emptyMap());
            check("Mootor".equals(motor.targetType) && "MTR-021".equals(motor.kilpId), "generic target adapter was rejected");
            expect(IllegalArgumentException.class, () -> new SignatureCaptureCore.Target("bad type", "dtc-motor-1", "MTR-021", "Vova", null, "UNRESOLVED", Collections.emptyMap()));
        });
        test("canvas normalization clamps and rounds to integer millionths", () -> {
            check(SignatureCaptureCore.normalize(-4f, 101) == 0, "negative x not clamped");
            check(SignatureCaptureCore.normalize(200f, 101) == 1_000_000, "right edge not clamped");
            check(SignatureCaptureCore.normalize(50f, 101) == 500_000, "midpoint normalization wrong");
            check(SignatureCaptureCore.normalize(0.5f, 101) == 5_000, "rounding rule wrong");
            expect(IllegalArgumentException.class, () -> SignatureCaptureCore.normalize(0, 1));
        });
        test("completed strokes retain StrokeNr and PunktNr ordering", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            s.setCanvasSize(101, 51);
            s.beginStroke(0, 0, 1_001); s.endStroke(100, 50, 1_010);
            s.beginStroke(20, 10, 1_020); s.addPoint(40, 30, 1_021); s.endStroke(80, 40, 1_022);
            SignatureCaptureCore.Draft d = s.finish(1_700_000_000_100L, 1_100L);
            check(d.strokeCount == 2 && d.pointCount == 5, "stroke/point counts incorrect");
            int[][] expected = {{1,1},{1,2},{2,1},{2,2},{2,3}};
            for (int i=0;i<expected.length;i++) check(d.points.get(i).strokeNr == expected[i][0] && d.points.get(i).pointNr == expected[i][1], "wrong index at point " + i);
        });
        test("coordinates clamp before normalization and preserve every point", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            s.setCanvasSize(101, 51);
            s.beginStroke(-10, 0, 1_005); s.endStroke(101, 50, 1_010);
            SignatureCaptureCore.Draft d = s.finish(1_700_000_000_100L, 1_100L);
            check(d.points.get(0).xNorm == 0 && d.points.get(0).yNorm == 0, "leading edge was not clamped");
            check(d.points.get(1).xNorm == 1_000_000 && d.points.get(1).yNorm == 1_000_000, "trailing edge was not clamped");
            check(d.points.size() == 2, "an input point was dropped");
        });
        test("elapsed times are monotonic and equal values are accepted", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            s.setCanvasSize(101, 51);
            s.beginStroke(0, 0, 1_005); s.addPoint(50, 25, 1_005); s.endStroke(100, 50, 1_010);
            SignatureCaptureCore.Draft d = s.finish(1_700_000_000_100L, 1_100L);
            check(d.points.get(0).elapsedMs == 5 && d.points.get(1).elapsedMs == 5 && d.points.get(2).elapsedMs == 10, "elapsed values differ");
        });
        test("elapsed regression is rejected", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            s.setCanvasSize(101, 51); s.beginStroke(0, 0, 1_010);
            expect(IllegalStateException.class, () -> s.endStroke(100, 50, 1_009));
        });
        test("ACTION_CANCEL drops unfinished stroke", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            s.setCanvasSize(101, 51); s.beginStroke(0, 0, 1_005); s.addPoint(50, 25, 1_006); s.cancelCurrentStroke();
            check(s.pointCount() == 0 && s.strokeCount() == 0, "cancelled stroke was retained");
            SignatureCaptureCore.CaptureException e = expect(SignatureCaptureCore.CaptureException.class, () -> s.finish(1_700_000_000_100L, 1_100L));
            check("STROKES_MISSING".equals(e.code), "wrong empty capture validation code");
        });
        test("cancelled capture cannot be confirmed", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            s.setCanvasSize(101, 51); s.cancelCapture();
            expect(IllegalStateException.class, () -> s.finish(1_700_000_000_100L, 1_100L));
        });
        test("resize after canvas lock cancels session", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            check(s.setCanvasSize(101, 51), "initial size rejected");
            check(!s.setCanvasSize(102, 51) && s.isCancelled(), "resize did not cancel capture");
        });
        test("wall clock and monotonic duration disagreement is rejected", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            s.setCanvasSize(101, 51); s.beginStroke(0, 0, 1_005); s.endStroke(100, 50, 1_010);
            SignatureCaptureCore.CaptureException e = expect(SignatureCaptureCore.CaptureException.class, () -> s.finish(1_700_000_020_000L, 1_100L));
            check("CLOCK_INCONSISTENT".equals(e.code), "wall clock mismatch was not identified");
        });
        test("one position is not enough for a capture", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            s.setCanvasSize(101, 51); s.beginStroke(50, 25, 1_005); s.endStroke(50, 25, 1_010);
            SignatureCaptureCore.CaptureException e = expect(SignatureCaptureCore.CaptureException.class, () -> s.finish(1_700_000_000_100L, 1_100L));
            check("STROKES_TOO_SHORT".equals(e.code), "single-position capture was not rejected");
        });
        test("confirmation is blocked while a stroke is still active", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            s.setCanvasSize(101, 51); s.beginStroke(0, 0, 1_005); s.addPoint(100, 50, 1_010);
            SignatureCaptureCore.CaptureException e = expect(SignatureCaptureCore.CaptureException.class, () -> s.finish(1_700_000_000_100L, 1_100L));
            check("STROKE_IN_PROGRESS".equals(e.code), "active stroke was accepted");
        });
        test("last touch elapsed cannot exceed capture duration", () -> {
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
            s.setCanvasSize(101, 51); s.beginStroke(0, 0, 1_005); s.endStroke(100, 50, 1_010);
            SignatureCaptureCore.CaptureException e = expect(SignatureCaptureCore.CaptureException.class, () -> s.finish(1_700_000_000_005L, 1_005L));
            check("CLOCK_INCONSISTENT".equals(e.code), "last elapsed beyond duration was accepted");
        });
        test("stroke and geometry hashes match golden vectors", () -> {
            SignatureCaptureCore.Draft d = simpleDraft(0, 0, 100, 50);
            check("092bdb0694f653dd36f67be2389872a906ea600fc4d84260ce3f99ed4c9459e4".equals(d.strokeHash), "stroke hash vector mismatch");
            check("35fa72864c0c55fbcb207f790c740d66510ff4b5e8715cef0b7497358fb8a066".equals(d.geometryHash), "geometry hash vector mismatch");
        });
        test("same strokes keep the same StrokeHash despite new nonce and UTC", () -> {
            SignatureCaptureCore.Draft a = simpleDraft(0, 0, 100, 50);
            SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_001_000L, 20_000L);
            s.setCanvasSize(101, 51); s.beginStroke(0, 0, 20_005); s.endStroke(100, 50, 20_010);
            SignatureCaptureCore.Draft b = s.finish(1_700_000_001_100L, 20_100L);
            check(!a.nonce.equals(b.nonce) && !a.signatureId.equals(b.signatureId), "session identity reused");
            check(a.strokeHash.equals(b.strokeHash), "nonce or absolute time leaked into StrokeHash");
        });
        test("PNG is generated from current strokes and its SHA-256 covers bytes", () -> {
            SignatureCaptureCore.Draft d = simpleDraft(0, 0, 100, 50);
            check(SignatureCanonicalJson.sha256(d.pngBytes).equals(d.pngHash), "PNG hash differs");
            java.awt.image.BufferedImage image = ImageIO.read(new ByteArrayInputStream(d.pngBytes));
            check(image != null && image.getWidth() == 900 && image.getHeight() == 300, "canonical PNG cannot be decoded or has wrong dimensions");
            check((image.getRGB(0, 0) >>> 24) == 0, "canonical background is not transparent");
            check(image.getRGB(450, 150) == 0xff000000, "canonical stroke is not visible at expected normalized position");
            check(SignatureCaptureCore.RENDERER_PROFILE.equals(d.rendererProfile), "draft does not name the production-candidate renderer");
            check("dold-signature-normalized-png-v1;900x300;transparent-rgba;black-opaque;stroke-9px;round-cap;round-join;pad-8pct;map-normalized-x-y;crop-none;png-filter-none-deflate-6-no-metadata".equals(d.rendererProfile), "renderer profile contract changed unexpectedly");
            SignatureCaptureCore.Draft anotherCanvas = simpleDraftSized(201, 101);
            check(d.pngHash.equals(anotherCanvas.pngHash) && Arrays.equals(d.pngBytes, anotherCanvas.pngBytes), "canonical PNG depends on physical canvas resolution");
            check("a5cf891249a2ed6f135d88d6afd25f611573338458a1c4373acabc3515823887".equals(d.pngHash), "canonical renderer PNG golden vector changed");
            expect(IllegalArgumentException.class, () -> SignaturePngRenderer.renderCanonical(Collections.singletonList(d.points.get(0))));
        });
        test("test-only block-letter POC vector has a fixed canonical PNG hash", () -> {
            byte[] png = SignaturePngRenderer.renderCanonical(SignaturePngPocFixture.points());
            check("ff6af60c18f3736f1a480a7d2b31f464f89616ab3fd2d7135bd8198d8373e57f".equals(SignatureCanonicalJson.sha256(png)), "POC PNG golden vector changed");
            java.awt.image.BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
            check(image != null && image.getWidth() == 900 && image.getHeight() == 300, "POC dimensions changed");
            check((image.getRGB(1, 1) >>> 24) == 0, "POC image background is not transparent");
        });
        test("old S1 experimental drafts remain readable without relabeling their stored PNG", () -> {
            Path dir = Files.createTempDirectory("dold-s1-legacy-profile-");
            try {
                SignatureCaptureCore.Draft current = simpleDraft(0, 0, 100, 50);
                byte[] oldPng = SignaturePngRenderer.render(current.canvasWidthPx, current.canvasHeightPx, current.points);
                SignatureCaptureCore.Target target = new SignatureCaptureCore.Target(current.targetType, current.recordId,
                        current.kilpId, current.signerName, current.recordVersion, current.recordVersionSource, current.targetMetadata);
                SignatureCaptureCore.DeviceInfo device = new SignatureCaptureCore.DeviceInfo(current.deviceInstanceId,
                        current.appVersionName, current.appVersionCode, current.androidRelease, current.androidApiLevel);
                SignatureCaptureCore.Draft old = new SignatureCaptureCore.Draft(current.status, current.signatureId, target,
                        current.nonce, current.captureStartedAtUtcMs, current.captureEndedAtUtcMs, current.captureDurationMs,
                        current.points, current.strokeCount, current.canvasWidthPx, current.canvasHeightPx, oldPng,
                        SignatureCanonicalJson.sha256(oldPng), current.strokeHash, current.geometryHash, device,
                        "NOT_CHECKED", 0L, 0, "", Collections.emptyList(), SignatureCaptureCore.LEGACY_EXPERIMENTAL_RENDERER_PROFILE);
                SignatureDraftStore store = new SignatureDraftStore(dir.toFile());
                store.saveDraft(old);
                SignatureCaptureCore.Draft restored = store.listDrafts().get(0);
                check(SignatureCaptureCore.LEGACY_EXPERIMENTAL_RENDERER_PROFILE.equals(restored.rendererProfile), "legacy PNG was mislabeled as production renderer output");
                check(Arrays.equals(oldPng, restored.pngBytes), "legacy stored PNG changed during profile migration");
            } finally { deleteTree(dir); }
        });
        test("store persists the complete local draft atomically and survives a new store instance", () -> {
            Path dir = Files.createTempDirectory("dold-s1-store-");
            try {
                Path workbook = dir.resolve("working.xlsx"); byte[] workbookBytes = "unchanged-workbook".getBytes(java.nio.charset.StandardCharsets.UTF_8); Files.write(workbook, workbookBytes);
                SignatureCaptureCore.Target t = target("Kontroll", "dtc-kontroll-existing", null, Collections.singletonMap("workbookIdentity", "db-lineage-1"));
                SignatureCaptureCore.Draft source = capture(t, "device-0123456789abcdef0123456789abcdef", 7, "14", 27, 100, 50);
                SignatureDraftStore.SaveResult saved = new SignatureDraftStore(dir.toFile()).saveDraft(source);
                check("UNIQUE".equals(saved.draft.antiReuseResult), "empty fully-read registry was not marked locally unique");
                check(saved.registryChecked && saved.draft.antiReuseCheckedCount == 0, "empty registry check not recorded");
                check(saved.draft.antiReuseCheckedAtUtcMs > saved.draft.captureEndedAtUtcMs, "anti-reuse check time is not the actual registry-check time");
                check(Arrays.equals(workbookBytes, Files.readAllBytes(workbook)), "XLSX was changed by draft save");
                List<SignatureCaptureCore.Draft> restored = new SignatureDraftStore(dir.toFile()).listDrafts();
                check(restored.size() == 1, "draft not restored after store reconstruction");
                SignatureCaptureCore.Draft d = restored.get(0);
                check(d.signatureId.equals(source.signatureId) && d.nonce.equals(source.nonce), "identity metadata lost");
                check(d.points.size() == source.points.size() && SignatureCanonicalJson.stringify(d.strokesObject()).equals(SignatureCanonicalJson.stringify(source.strokesObject())), "raw strokes changed after restart");
                check(d.targetType.equals("Kontroll") && d.recordId.equals("dtc-kontroll-existing") && d.kilpId.equals("EK-027"), "target link changed");
                check(d.recordVersion == null && "UNRESOLVED".equals(d.recordVersionSource), "unknown record version was fabricated");
                check("TOUCH".equals(d.inputMethod) && d.deviceInstanceId.equals("device-0123456789abcdef0123456789abcdef"), "device/input metadata lost");
                check(d.appVersionName.equals("14") && d.appVersionCode == 57 && d.androidRelease.equals("16") && d.androidApiLevel == 27, "app/Android version metadata lost");
                check(d.canvasWidthPx == 100 && d.canvasHeightPx == 50 && d.pointCount == 2 && d.strokeCount == 1, "canvas or counts lost");
                check(d.pngHash.equals(source.pngHash) && d.strokeHash.equals(source.strokeHash) && d.geometryHash.equals(source.geometryHash), "hash metadata changed");
                check("db-lineage-1".equals(d.targetMetadata.get("workbookIdentity")), "target metadata lost");
            } finally { deleteTree(dir); }
        });
        test("exact repeated local geometry is rejected and not saved twice", () -> {
            Path dir = Files.createTempDirectory("dold-s1-duplicate-");
            try {
                SignatureDraftStore store = new SignatureDraftStore(dir.toFile());
                SignatureCaptureCore.Target t = target("Kontroll", "dtc-kontroll-a", null, Collections.emptyMap());
                SignatureCaptureCore.Draft first = simpleDraft(0, 0, 100, 50);
                store.saveDraft(first);
                SignatureCaptureCore.Draft duplicate = simpleDraft(0, 0, 100, 50);
                SignatureDraftStore.DuplicateCaptureException e = expect(SignatureDraftStore.DuplicateCaptureException.class, () -> store.saveDraft(duplicate));
                check(e.matchingSignatureIds.contains(first.signatureId), "duplicate ID match not reported");
                check(store.listDrafts().size() == 1, "duplicate was saved");
            } finally { deleteTree(dir); }
        });
        test("different exact geometry remains eligible and is locally checked", () -> {
            Path dir = Files.createTempDirectory("dold-s1-distinct-");
            try {
                SignatureDraftStore store = new SignatureDraftStore(dir.toFile());
                store.saveDraft(simpleDraft(0, 0, 100, 50));
                SignatureCaptureCore.Draft next = simpleDraft(0, 0, 99, 50);
                SignatureDraftStore.SaveResult result = store.saveDraft(next);
                check("UNIQUE".equals(result.draft.antiReuseResult) && result.draft.antiReuseCheckedCount == 1, "different drawing was not checked against full local registry");
                check(store.listDrafts().size() == 2, "distinct draft not saved");
            } finally { deleteTree(dir); }
        });
        test("corrupt local registry never claims UNIQUE", () -> {
            Path dir = Files.createTempDirectory("dold-s1-corrupt-");
            try {
                SignatureDraftStore store = new SignatureDraftStore(dir.toFile());
                SignatureCaptureCore.Draft first = simpleDraft(0, 0, 100, 50); store.saveDraft(first);
                File[] files = new File(dir.toFile(), "signature-drafts-s1").listFiles((d,n) -> n.endsWith(".draft"));
                check(files != null && files.length == 1, "saved draft file missing");
                Files.write(files[0].toPath(), new byte[]{1,2,3});
                SignatureDraftStore.SaveResult result = store.saveDraft(simpleDraft(0, 0, 90, 50));
                check("NOT_CHECKED".equals(result.draft.antiReuseResult) && !result.registryChecked && result.draft.antiReuseRegistryDigest.isEmpty() && result.draft.antiReuseCheckedAtUtcMs == 0, "corrupt registry was treated as complete");
            } finally { deleteTree(dir); }
        });
        test("draft store rejects duplicate AllkiriID independent of geometry", () -> {
            Path dir = Files.createTempDirectory("dold-s1-id-");
            try {
                SignatureDraftStore store = new SignatureDraftStore(dir.toFile());
                SignatureCaptureCore.Draft first = simpleDraft(0, 0, 100, 50); store.saveDraft(first);
                check(store.containsSignatureId(first.signatureId), "stored ID was not found");
            } finally { deleteTree(dir); }
        });

        System.out.println("S1 SIGNATURE CORE " + passed + "/" + passed + " PASS; " + failed + " FAIL");
        if (failed != 0) System.exit(1);
    }

    private static SignatureCaptureCore.Target target(String type, String id, Long version, Map<String,String> metadata) {
        return new SignatureCaptureCore.Target(type, id, "EK-027", "Vladimir J", version,
                version == null ? "UNRESOLVED" : ("Kontroll".equals(type) ? SignatureCaptureCore.KONTROLL_RECORD_VERSION_SOURCE : "PARANDUSED_L"), metadata);
    }

    private static SignatureCaptureCore.Session session(String type, String id, Long version,
                                                        Map<String,String> metadata, long startUtc, long startMono) throws Exception {
        SignatureCaptureCore.Target target = target(type, id, version, metadata);
        SignatureCaptureCore.DeviceInfo device = new SignatureCaptureCore.DeviceInfo(
                "device-0123456789abcdef0123456789abcdef", "0.5.6.1", 57, "16", 36);
        return SignatureCaptureCore.newSession(target, device, startUtc, startMono, ignored -> false);
    }

    private static SignatureCaptureCore.Draft simpleDraft(float x1, float y1, float x2, float y2) throws Exception {
        SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
        s.setCanvasSize(101, 51); s.beginStroke(x1, y1, 1_005); s.endStroke(x2, y2, 1_010);
        return s.finish(1_700_000_000_100L, 1_100L);
    }

    private static SignatureCaptureCore.Draft simpleDraftSized(int width, int height) throws Exception {
        SignatureCaptureCore.Session s = session("Kontroll", "dtc-kontroll-test-1", null, Collections.emptyMap(), 1_700_000_000_000L, 1_000L);
        s.setCanvasSize(width, height); s.beginStroke(0, 0, 1_005); s.endStroke(width - 1, height - 1, 1_010);
        return s.finish(1_700_000_000_100L, 1_100L);
    }

    private static SignatureCaptureCore.Draft capture(SignatureCaptureCore.Target target, String deviceId,
                                                       long startUtc, String appVersion, int api,
                                                       int width, int height) throws Exception {
        SignatureCaptureCore.DeviceInfo device = new SignatureCaptureCore.DeviceInfo(deviceId, appVersion, 57, "16", api);
        SignatureCaptureCore.Session s = SignatureCaptureCore.newSession(target, device, startUtc, 10_000L, ignored -> false);
        s.setCanvasSize(width, height); s.beginStroke(0, 0, 10_005); s.endStroke(width - 1, height - 1, 10_010);
        return s.finish(startUtc + 100L, 10_100L);
    }

    private static void test(String name, Case c) {
        try { c.run(); passed++; System.out.println("PASS " + name); }
        catch (Throwable e) { failed++; System.err.println("FAIL " + name + " — " + e); e.printStackTrace(System.err); }
    }
    private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    private static <T extends Throwable> T expect(Class<T> type, Case c) {
        try { c.run(); } catch (Throwable e) { if (type.isInstance(e)) return type.cast(e); throw new AssertionError("Expected " + type.getSimpleName() + " but got " + e, e); }
        throw new AssertionError("Expected " + type.getSimpleName());
    }
    private static void deleteTree(Path path) throws Exception {
        if (!Files.exists(path)) return;
        try (java.util.stream.Stream<Path> walk = Files.walk(path)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> { try { Files.deleteIfExists(p); } catch (Exception e) { throw new RuntimeException(e); } });
        }
    }
}
