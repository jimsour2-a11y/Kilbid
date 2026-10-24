package ee.dold.techcontrol;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;

/** Native MotionEvent surface. It records finger touch points and never accepts an imported image. */
final class SignaturePadView extends View {
    interface Listener {
        void onStrokeChanged();
        void onCaptureInvalidated(String message);
    }

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private SignatureCaptureCore.Session session;
    private Listener listener;

    SignaturePadView(Context context, SignatureCaptureCore.Session session, Listener listener) {
        super(context);
        this.session = session;
        this.listener = listener;
        setBackgroundColor(Color.WHITE);
        setFocusable(true);
        setFocusableInTouchMode(true);
        paint.setColor(Color.BLACK);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setStrokeJoin(Paint.Join.ROUND);
    }

    void setSession(SignatureCaptureCore.Session session) {
        this.session = session;
        if (session != null && getWidth() >= 2 && getHeight() >= 2) session.setCanvasSize(getWidth(), getHeight());
        invalidate();
    }

    void setListener(Listener listener) { this.listener = listener; }

    @Override protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        if (width < 2 || height < 2 || session == null || session.isCancelled()) return;
        try {
            if (!session.setCanvasSize(width, height)) {
                if (listener != null) listener.onCaptureInvalidated("Ekraani suurus muutus. Allkirjastamine katkestati.");
            }
        } catch (IllegalArgumentException e) {
            if (listener != null) listener.onCaptureInvalidated("Allkirja ala pole kasutatav.");
        }
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        canvas.drawColor(Color.WHITE);
        if (session == null || session.isCancelled()) return;
        paint.setStrokeWidth(Math.max(2f, Math.min(getWidth(), getHeight()) * 0.02f));
        for (java.util.List<SignatureCaptureCore.Point> stroke : session.previewStrokes()) {
            if (stroke.isEmpty()) continue;
            SignatureCaptureCore.Point first = stroke.get(0);
            float x = first.xNorm * Math.max(1, getWidth() - 1) / 1_000_000f;
            float y = first.yNorm * Math.max(1, getHeight() - 1) / 1_000_000f;
            if (stroke.size() == 1) {
                canvas.drawCircle(x, y, paint.getStrokeWidth() / 2f, paint);
                continue;
            }
            Path path = new Path();
            path.moveTo(x, y);
            for (int i = 1; i < stroke.size(); i++) {
                SignatureCaptureCore.Point point = stroke.get(i);
                path.lineTo(point.xNorm * Math.max(1, getWidth() - 1) / 1_000_000f,
                        point.yNorm * Math.max(1, getHeight() - 1) / 1_000_000f);
            }
            canvas.drawPath(path, paint);
        }
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        if (session == null || session.isCancelled()) return false;
        final int action = event.getActionMasked();
        final long elapsed = SystemClock.elapsedRealtime();
        try {
            if (action == MotionEvent.ACTION_DOWN) {
                if (event.getToolType(0) != MotionEvent.TOOL_TYPE_FINGER) return false;
                requestDisallowInterceptTouchEvent(true);
                requestFocus();
                session.beginStroke(event.getX(0), event.getY(0), elapsed);
                invalidate();
                return true;
            }
            if (action == MotionEvent.ACTION_MOVE) {
                if (!session.hasActiveStroke()) return true;
                for (int i = 0; i < event.getHistorySize(); i++)
                    session.addPoint(event.getHistoricalX(0, i), event.getHistoricalY(0, i), elapsed);
                session.addPoint(event.getX(0), event.getY(0), elapsed);
                invalidate();
                return true;
            }
            if (action == MotionEvent.ACTION_UP) {
                if (!session.hasActiveStroke()) return true;
                for (int i = 0; i < event.getHistorySize(); i++)
                    session.addPoint(event.getHistoricalX(0, i), event.getHistoricalY(0, i), elapsed);
                session.endStroke(event.getX(0), event.getY(0), elapsed);
                requestDisallowInterceptTouchEvent(false);
                invalidate();
                if (listener != null) listener.onStrokeChanged();
                return true;
            }
            if (action == MotionEvent.ACTION_CANCEL) {
                session.cancelCurrentStroke();
                requestDisallowInterceptTouchEvent(false);
                invalidate();
                if (listener != null) listener.onStrokeChanged();
                return true;
            }
            if (action == MotionEvent.ACTION_POINTER_DOWN || action == MotionEvent.ACTION_POINTER_UP) return true;
            return session.hasActiveStroke();
        } catch (IllegalStateException e) {
            requestDisallowInterceptTouchEvent(false);
            if (listener != null) listener.onCaptureInvalidated(e.getMessage() == null ? "Allkirjastamine katkestati." : e.getMessage());
            return false;
        }
    }
}
