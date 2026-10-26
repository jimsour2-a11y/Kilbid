package ee.dold.techcontrol;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import java.util.zip.DeflaterOutputStream;

/** Canonical S1.5 renderer. It rasterizes normalized points, never a screenshot or imported image. */
final class SignaturePngRenderer {
    static final String PROFILE_V1 = "dold-signature-normalized-png-v1;900x300;transparent-rgba;black-opaque;stroke-9px;round-cap;round-join;pad-8pct;map-normalized-x-y;crop-none;png-filter-none-deflate-6-no-metadata";
    static final String PROFILE_V2 = "dold-signature-fitted-png-v2;900x300;transparent-rgba;black-opaque;stroke-9px;round-cap;round-join;ink-bounds;pad-8pct;preserve-aspect;center;png-filter-none-deflate-6-no-metadata";
    static final String PROFILE = PROFILE_V2;
    static final int CANONICAL_WIDTH = 900;
    static final int CANONICAL_HEIGHT = 300;
    private static final int CANONICAL_PADDING_X = 72;
    private static final int CANONICAL_PADDING_Y = 24;
    private static final int CANONICAL_RADIUS = 4;
    private static final byte[] PNG_SIGNATURE = new byte[]{(byte) 137, 80, 78, 71, 13, 10, 26, 10};
    private static final int MAX_PIXELS = 4_000_000;

    private SignaturePngRenderer() {}

    static byte[] renderCanonical(List<SignatureCaptureCore.Point> points) {
        return renderFittedCanonical(points);
    }

    static boolean isSupportedProductionProfile(String profile) {
        return PROFILE_V1.equals(profile) || PROFILE_V2.equals(profile);
    }

    /** Current deterministic renderer. Fits normalized ink into the padded frame without changing aspect ratio. */
    static byte[] renderFittedCanonical(List<SignatureCaptureCore.Point> points) {
        if (points == null || points.size() < 2) throw new IllegalArgumentException("Allkirja jaoks on vaja vähemalt kahte punkti");
        int width = CANONICAL_WIDTH, height = CANONICAL_HEIGHT;
        int minX = 1_000_000, maxX = 0, minY = 1_000_000, maxY = 0;
        int previousStroke = 0, previousPoint = 0, previousElapsed = -1;
        java.util.Set<Long> positions = new java.util.HashSet<>();
        for (SignatureCaptureCore.Point point : points) {
            if (point == null || point.strokeNr < 1 || point.xNorm < 0 || point.xNorm > 1_000_000
                    || point.yNorm < 0 || point.yNorm > 1_000_000 || point.elapsedMs < previousElapsed)
                throw new IllegalArgumentException("Allkirja normaliseeritud punkt on vigane");
            if (previousPoint == 0) {
                if (point.strokeNr != 1 || point.pointNr != 1) throw new IllegalArgumentException("Allkirja punktide järjekord on vigane");
            } else if (point.strokeNr == previousStroke) {
                if (point.pointNr != previousPoint + 1) throw new IllegalArgumentException("Allkirja punktide järjekord on vigane");
            } else if (point.strokeNr == previousStroke + 1 && point.pointNr == 1) {
                // A new stroke starts at point one; renderer starts a round cap below.
            } else {
                throw new IllegalArgumentException("Allkirja joonte järjekord on vigane");
            }
            minX = Math.min(minX, point.xNorm); maxX = Math.max(maxX, point.xNorm);
            minY = Math.min(minY, point.yNorm); maxY = Math.max(maxY, point.yNorm);
            positions.add((((long) point.xNorm) << 20) | point.yNorm);
            previousStroke = point.strokeNr; previousPoint = point.pointNr; previousElapsed = point.elapsedMs;
        }
        if (positions.size() < 2) throw new IllegalArgumentException("Allkirja geomeetria on liiga lühike");

        double extentX = maxX - (double) minX, extentY = maxY - (double) minY;
        double fitWidth = width - 2d * CANONICAL_PADDING_X - 2d * CANONICAL_RADIUS - 2d;
        double fitHeight = height - 2d * CANONICAL_PADDING_Y - 2d * CANONICAL_RADIUS - 2d;
        double scaleX = extentX > 0d ? fitWidth / extentX : Double.POSITIVE_INFINITY;
        double scaleY = extentY > 0d ? fitHeight / extentY : Double.POSITIVE_INFINITY;
        double scale = Math.min(scaleX, scaleY);
        if (!Double.isFinite(scale) || scale <= 0d) throw new IllegalArgumentException("Allkirja geomeetria ei mahu PNG-pildile");
        double centerX = (minX + (double) maxX) / 2d, centerY = (minY + (double) maxY) / 2d;
        double outputCenterX = (width - 1d) / 2d, outputCenterY = (height - 1d) / 2d;

        byte[] pixels = new byte[Math.multiplyExact(Math.multiplyExact(width, height), 4)]; // transparent RGBA
        SignatureCaptureCore.Point previous = null;
        int previousStrokeForRaster = 0;
        for (SignatureCaptureCore.Point point : points) {
            int x = (int) Math.round(outputCenterX + (point.xNorm - centerX) * scale);
            int y = (int) Math.round(outputCenterY + (point.yNorm - centerY) * scale);
            if (previous == null || point.strokeNr != previousStrokeForRaster) {
                drawDisk(pixels, width, height, x, y, CANONICAL_RADIUS);
            } else {
                int previousX = (int) Math.round(outputCenterX + (previous.xNorm - centerX) * scale);
                int previousY = (int) Math.round(outputCenterY + (previous.yNorm - centerY) * scale);
                drawLine(pixels, width, height, previousX, previousY, x, y, CANONICAL_RADIUS);
            }
            previous = point;
            previousStrokeForRaster = point.strokeNr;
        }
        return encodePng(width, height, pixels);
    }

    /** Exact renderer for already-created v1 drafts/proofs. Do not change its mapping or output. */
    static byte[] renderCanonicalV1(List<SignatureCaptureCore.Point> points) {
        if (points == null || points.size() < 2) throw new IllegalArgumentException("Allkirja jaoks on vaja vähemalt kahte punkti");
        int width = CANONICAL_WIDTH, height = CANONICAL_HEIGHT;
        byte[] pixels = new byte[Math.multiplyExact(Math.multiplyExact(width, height), 4)]; // transparent RGBA
        SignatureCaptureCore.Point previous = null;
        int previousStroke = 0, previousPoint = 0, previousElapsed = -1;
        java.util.Set<Long> positions = new java.util.HashSet<>();
        for (SignatureCaptureCore.Point point : points) {
            if (point == null || point.strokeNr < 1 || point.xNorm < 0 || point.xNorm > 1_000_000
                    || point.yNorm < 0 || point.yNorm > 1_000_000 || point.elapsedMs < previousElapsed)
                throw new IllegalArgumentException("Allkirja normaliseeritud punkt on vigane");
            if (previous == null) {
                if (point.strokeNr != 1 || point.pointNr != 1) throw new IllegalArgumentException("Allkirja punktide järjekord on vigane");
            } else if (point.strokeNr == previousStroke) {
                if (point.pointNr != previousPoint + 1) throw new IllegalArgumentException("Allkirja punktide järjekord on vigane");
            } else if (point.strokeNr == previousStroke + 1 && point.pointNr == 1) {
                previous = null;
            } else {
                throw new IllegalArgumentException("Allkirja joonte järjekord on vigane");
            }
            int x = CANONICAL_PADDING_X + Math.round(point.xNorm * (width - 1 - 2f * CANONICAL_PADDING_X) / 1_000_000f);
            int y = CANONICAL_PADDING_Y + Math.round(point.yNorm * (height - 1 - 2f * CANONICAL_PADDING_Y) / 1_000_000f);
            if (previous == null) {
                drawDisk(pixels, width, height, x, y, CANONICAL_RADIUS);
            } else {
                int px = CANONICAL_PADDING_X + Math.round(previous.xNorm * (width - 1 - 2f * CANONICAL_PADDING_X) / 1_000_000f);
                int py = CANONICAL_PADDING_Y + Math.round(previous.yNorm * (height - 1 - 2f * CANONICAL_PADDING_Y) / 1_000_000f);
                drawLine(pixels, width, height, px, py, x, y, CANONICAL_RADIUS);
            }
            positions.add((((long) point.xNorm) << 20) | point.yNorm);
            previous = point;
            previousStroke = point.strokeNr;
            previousPoint = point.pointNr;
            previousElapsed = point.elapsedMs;
        }
        if (positions.size() < 2) throw new IllegalArgumentException("Allkirja geomeetria on liiga lühike");
        return encodePng(width, height, pixels);
    }

    static byte[] render(int width, int height, List<SignatureCaptureCore.Point> points) {
        if (width < 2 || height < 2 || (long) width * height > MAX_PIXELS)
            throw new IllegalArgumentException("Allkirja pildi mõõtmed ei ole toetatud");
        if (points == null || points.isEmpty()) throw new IllegalArgumentException("Allkirja puutepunktid puuduvad");
        int pixelBytes = Math.multiplyExact(Math.multiplyExact(width, height), 4);
        byte[] pixels = new byte[pixelBytes];
        java.util.Arrays.fill(pixels, (byte) 0xff); // opaque white RGBA background
        int radius = Math.max(1, Math.round(Math.min(width, height) * 0.01f));
        SignatureCaptureCore.Point previous = null;
        int previousStroke = -1;
        for (SignatureCaptureCore.Point point : points) {
            int x = Math.round(point.xNorm * (width - 1f) / 1_000_000f);
            int y = Math.round(point.yNorm * (height - 1f) / 1_000_000f);
            if (previous == null || point.strokeNr != previousStroke) {
                drawDisk(pixels, width, height, x, y, radius);
            } else {
                drawLine(pixels, width, height,
                        Math.round(previous.xNorm * (width - 1f) / 1_000_000f),
                        Math.round(previous.yNorm * (height - 1f) / 1_000_000f), x, y, radius);
            }
            previous = point;
            previousStroke = point.strokeNr;
        }
        return encodePng(width, height, pixels);
    }

    private static void drawLine(byte[] pixels, int width, int height, int x0, int y0, int x1, int y1, int radius) {
        int dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
        int dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
        int error = dx + dy;
        while (true) {
            drawDisk(pixels, width, height, x0, y0, radius);
            if (x0 == x1 && y0 == y1) break;
            int twice = 2 * error;
            if (twice >= dy) { error += dy; x0 += sx; }
            if (twice <= dx) { error += dx; y0 += sy; }
        }
    }

    private static void drawDisk(byte[] pixels, int width, int height, int centerX, int centerY, int radius) {
        int radiusSq = radius * radius;
        int minX = Math.max(0, centerX - radius), maxX = Math.min(width - 1, centerX + radius);
        int minY = Math.max(0, centerY - radius), maxY = Math.min(height - 1, centerY + radius);
        for (int y = minY; y <= maxY; y++) {
            for (int x = minX; x <= maxX; x++) {
                int dx = x - centerX, dy = y - centerY;
                if (dx * dx + dy * dy > radiusSq) continue;
                int index = (y * width + x) * 4;
                pixels[index] = 0;
                pixels[index + 1] = 0;
                pixels[index + 2] = 0;
                pixels[index + 3] = (byte) 255;
            }
        }
    }

    private static byte[] encodePng(int width, int height, byte[] pixels) {
        try {
            ByteArrayOutputStream scanlines = new ByteArrayOutputStream(height * (width * 4 + 1));
            for (int y = 0; y < height; y++) {
                scanlines.write(0); // PNG filter: None
                scanlines.write(pixels, y * width * 4, width * 4);
            }
            ByteArrayOutputStream compressed = new ByteArrayOutputStream();
            Deflater deflater = new Deflater(6, false);
            try (DeflaterOutputStream deflate = new DeflaterOutputStream(compressed, deflater)) {
                scanlines.writeTo(deflate);
            } finally {
                deflater.end();
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            out.write(PNG_SIGNATURE);
            ByteArrayOutputStream headerBytes = new ByteArrayOutputStream(13);
            DataOutputStream header = new DataOutputStream(headerBytes);
            header.writeInt(width);
            header.writeInt(height);
            header.writeByte(8); // bit depth
            header.writeByte(6); // RGBA
            header.writeByte(0); // compression
            header.writeByte(0); // filter
            header.writeByte(0); // no interlace
            writeChunk(out, "IHDR", headerBytes.toByteArray());
            writeChunk(out, "IDAT", compressed.toByteArray());
            writeChunk(out, "IEND", new byte[0]);
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException("PNG render failed", e);
        }
    }

    private static void writeChunk(ByteArrayOutputStream out, String type, byte[] data) throws IOException {
        DataOutputStream stream = new DataOutputStream(out);
        byte[] typeBytes = type.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        stream.writeInt(data.length);
        stream.write(typeBytes);
        stream.write(data);
        CRC32 crc = new CRC32();
        crc.update(typeBytes);
        crc.update(data);
        stream.writeInt((int) crc.getValue());
    }
}
