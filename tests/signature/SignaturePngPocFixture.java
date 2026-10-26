package ee.dold.techcontrol;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** Deterministic block-letter POC geometry. It is explicitly not a person's signature. */
public final class SignaturePngPocFixture {
    private SignaturePngPocFixture() {}

    static List<SignatureCaptureCore.Point> points() {
        List<SignatureCaptureCore.Point> points = new ArrayList<>();
        int elapsed = 0;
        int[][][] strokes = {
                {{100_000, 200_000}, {100_000, 800_000}, {300_000, 800_000}, {300_000, 500_000}, {100_000, 500_000}},
                {{450_000, 200_000}, {650_000, 200_000}, {650_000, 800_000}, {450_000, 800_000}, {450_000, 200_000}},
                {{900_000, 200_000}, {700_000, 200_000}, {700_000, 800_000}, {900_000, 800_000}}
        };
        for (int stroke = 0; stroke < strokes.length; stroke++) {
            for (int point = 0; point < strokes[stroke].length; point++) {
                points.add(new SignatureCaptureCore.Point(stroke + 1, point + 1,
                        strokes[stroke][point][0], strokes[stroke][point][1], elapsed));
                elapsed += 25;
            }
        }
        return points;
    }

    public static void main(String[] args) throws Exception {
        boolean legacyV1 = args.length > 1 && "--v1".equals(args[1]);
        byte[] png = legacyV1 ? SignaturePngRenderer.renderCanonicalV1(points()) : SignaturePngRenderer.renderCanonical(points());
        if (args.length > 0) Files.write(Path.of(args[0]), png);
        System.out.println("profile=" + (legacyV1 ? SignaturePngRenderer.PROFILE_V1 : SignaturePngRenderer.PROFILE));
        System.out.println("width=" + SignaturePngRenderer.CANONICAL_WIDTH);
        System.out.println("height=" + SignaturePngRenderer.CANONICAL_HEIGHT);
        System.out.println("sha256=" + SignatureCanonicalJson.sha256(png));
        System.out.println("bytes=" + png.length);
    }
}
