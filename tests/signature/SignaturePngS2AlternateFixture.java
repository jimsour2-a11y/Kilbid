package ee.dold.techcontrol;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** Test-only alternate capture rendered by the production S1.5 renderer. */
public final class SignaturePngS2AlternateFixture {
    private SignaturePngS2AlternateFixture() {}

    static List<SignatureCaptureCore.Point> points() {
        List<SignatureCaptureCore.Point> points = new ArrayList<>();
        points.add(new SignatureCaptureCore.Point(1, 1, 150_000, 220_000, 0));
        points.add(new SignatureCaptureCore.Point(1, 2, 280_000, 760_000, 100));
        points.add(new SignatureCaptureCore.Point(2, 1, 620_000, 300_000, 200));
        points.add(new SignatureCaptureCore.Point(2, 2, 840_000, 700_000, 300));
        return points;
    }

    public static void main(String[] args) throws Exception {
        byte[] png = SignaturePngRenderer.renderCanonical(points());
        if (args.length > 0) Files.write(Path.of(args[0]), png);
        System.out.println("profile=" + SignaturePngRenderer.PROFILE);
        System.out.println("width=" + SignaturePngRenderer.CANONICAL_WIDTH);
        System.out.println("height=" + SignaturePngRenderer.CANONICAL_HEIGHT);
        System.out.println("sha256=" + SignatureCanonicalJson.sha256(png));
        System.out.println("bytes=" + png.length);
    }
}
