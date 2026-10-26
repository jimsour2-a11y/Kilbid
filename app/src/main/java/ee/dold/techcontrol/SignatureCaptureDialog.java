package ee.dold.techcontrol;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.view.WindowCompat;

/** Responsive native S1 capture sheet. It only persists local drafts, never production XLSX rows. */
final class SignatureCaptureDialog {
    interface Listener {
        void onDraftSaved(SignatureCaptureCore.Draft draft);
        void onCaptureCancelled(String reason);
    }

    private final Activity activity;
    private final SignatureDraftStore store;
    private final SignatureCaptureCore.Target target;
    private final SignatureCaptureCore.DeviceInfo device;
    private final Listener listener;
    private Dialog dialog;
    private LinearLayout root;
    private SignaturePadView pad;
    private TextView status;
    private TextView sessionId;
    private SignatureCaptureCore.Session session;
    private boolean terminal;

    SignatureCaptureDialog(Activity activity, SignatureDraftStore store,
                           SignatureCaptureCore.Target target, SignatureCaptureCore.DeviceInfo device,
                           Listener listener) {
        this.activity = activity;
        this.store = store;
        this.target = target;
        this.device = device;
        this.listener = listener;
        this.session = newSession();
    }

    boolean isShowing() { return dialog != null && dialog.isShowing(); }

    void show() {
        if (activity.isFinishing() || activity.isDestroyed()) throw new IllegalStateException("Rakendus ei ole aktiivne");
        dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(246, 248, 250));
        int edge = dp(14);
        root.setPadding(edge, dp(8), edge, dp(8));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int top, bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(edge, Math.max(dp(8), top + dp(6)), edge, Math.max(dp(8), bottom + dp(6)));
            return insets;
        });

        LinearLayout header = new LinearLayout(activity);
        header.setOrientation(LinearLayout.VERTICAL);
        TextView title = text("ALLKIRI", 24, true, Color.rgb(24, 38, 52));
        header.addView(title, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView targetText = text(target.targetType + " • " + target.kilpId + "\nKirje: " + target.recordId, 15, true, Color.rgb(33, 52, 70));
        targetText.setPadding(0, dp(5), 0, dp(3));
        header.addView(targetText, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView signer = text("Allkirjastaja: " + target.signerName, 15, false, Color.rgb(53, 65, 76));
        header.addView(signer, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        String version = target.recordVersion == null
                ? "Kirje versioon: lahendamata. See on ainult kohalik mustand."
                : "Kirje versioon: " + target.recordVersion + " (" + target.recordVersionSource + ")";
        TextView versionText = text(version, 12, false, target.recordVersion == null ? Color.rgb(150, 88, 0) : Color.rgb(90, 102, 113));
        versionText.setPadding(0, dp(3), 0, dp(2));
        header.addView(versionText, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView instructions = text("Kirjuta allkiri sõrmega. Kinnita salvestab esmalt telefoni mustandi; DOLD kontrollib selle ja proovib lisada aktiivsesse tööfaili.", 12, false, Color.rgb(90, 102, 113));
        instructions.setPadding(0, 0, 0, dp(6));
        header.addView(instructions, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        ScrollView headerScroll = new ScrollView(activity);
        headerScroll.setFillViewport(false);
        headerScroll.setClipToPadding(false);
        headerScroll.setVerticalScrollBarEnabled(true);
        headerScroll.addView(header, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(headerScroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0.36f));

        pad = new SignaturePadView(activity, session, new SignaturePadView.Listener() {
            @Override public void onStrokeChanged() { updateStatus(); }
            @Override public void onCaptureInvalidated(String message) { cancelWithMessage(message); }
        });
        GradientDrawable border = new GradientDrawable();
        border.setColor(Color.WHITE);
        border.setCornerRadius(dp(8));
        border.setStroke(dp(1), Color.rgb(169, 181, 192));
        pad.setBackground(border);
        pad.setClipToOutline(true);
        LinearLayout.LayoutParams padParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 0.64f);
        padParams.topMargin = dp(2);
        padParams.bottomMargin = dp(6);
        pad.setMinimumHeight(dp(96));
        root.addView(pad, padParams);

        status = text("Allkirja pole veel joonistatud.", 12, false, Color.rgb(83, 96, 109));
        sessionId = text("Mustandi ID: " + session.signatureId, 10, false, Color.rgb(125, 134, 142));
        root.addView(status, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(sessionId, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout actions = new LinearLayout(activity);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.setPadding(0, dp(4), 0, 0);
        Button clear = button("TÜHJENDA", v -> clearCapture());
        Button back = button("TAGASI", v -> cancel("Allkirjastamine tühistati."));
        Button confirm = button("KINNITA", v -> confirmCapture());
        actions.addView(clear, actionParams());
        actions.addView(back, actionParams());
        actions.addView(confirm, actionParams());
        root.addView(actions, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        dialog.setContentView(root);
        dialog.setCancelable(true);
        dialog.setOnCancelListener(d -> cancel("Allkirjastamine tühistati."));
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.WHITE);
            window.setNavigationBarColor(Color.WHITE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                window.getDecorView().setSystemUiVisibility(flags);
            }
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
        }
        dialog.show();
        if (window != null) {
            window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT);
            window.getDecorView().requestApplyInsets();
        }
    }

    void cancelFromLifecycle() {
        cancel("Allkirjastamine katkestati rakenduse sulgemisel.");
    }

    private SignatureCaptureCore.Session newSession() {
        try {
            SignatureCaptureCore.Identity identity = SignatureCaptureCore.newIdentity(store::containsSignatureId);
            return new SignatureCaptureCore.Session(target, device, identity, System.currentTimeMillis(), SystemClock.elapsedRealtime());
        } catch (Exception e) {
            throw new IllegalStateException("Allkirja uut sessiooni ei saanud luua", e);
        }
    }

    private void clearCapture() {
        try {
            if (session != null) session.cancelCapture();
            session = newSession();
            if (pad != null) pad.setSession(session);
            if (sessionId != null) sessionId.setText("Mustandi ID: " + session.signatureId);
            setStatus("Allkiri tühjendati. Alusta uuest sessioonist.", Color.rgb(83, 96, 109));
        } catch (Exception e) {
            cancelWithMessage("Uut allkirja sessiooni ei saanud luua.");
        }
    }

    private void confirmCapture() {
        if (terminal || session == null) return;
        try {
            SignatureCaptureCore.Draft draft = session.finish(System.currentTimeMillis(), SystemClock.elapsedRealtime());
            SignatureDraftStore.SaveResult saved = store.saveDraft(draft);
            terminal = true;
            if (dialog != null) dialog.dismiss();
            if (listener != null) listener.onDraftSaved(saved.draft);
        } catch (SignatureDraftStore.DuplicateCaptureException e) {
            setStatus("See joonistus kordub telefoni teadaolevas registris. Vajuta TÜHJENDA ja allkirjasta uuesti.", Color.rgb(176, 38, 38));
            clearIdentityOnlyAfterDuplicate();
        } catch (SignatureCaptureCore.CaptureException e) {
            setStatus(e.getMessage(), Color.rgb(176, 38, 38));
        } catch (Exception e) {
            setStatus("Allkirja mustandit ei saanud telefoni salvestada. XLSX jäi muutmata.", Color.rgb(176, 38, 38));
        }
    }

    private void clearIdentityOnlyAfterDuplicate() {
        // Keep the visible duplicate warning until the user explicitly clears the pad.
        if (sessionId != null) sessionId.setText("Korduv allkiri ei salvestatud. Vajuta TÜHJENDA.");
    }

    private void cancelWithMessage(String message) {
        if (terminal) return;
        terminal = true;
        if (session != null) session.cancelCapture();
        if (pad != null) pad.setListener(null);
        if (dialog != null) dialog.dismiss();
        if (listener != null) listener.onCaptureCancelled(message);
    }

    private void cancel(String message) {
        if (terminal) return;
        terminal = true;
        if (session != null) session.cancelCapture();
        if (pad != null) pad.setListener(null);
        if (dialog != null && dialog.isShowing()) dialog.dismiss();
        if (listener != null) listener.onCaptureCancelled(message);
    }

    private void updateStatus() {
        if (session == null || status == null) return;
        int points = session.pointCount();
        int strokes = session.strokeCount();
        setStatus(points == 0 ? "Allkirja pole veel joonistatud." : "Jooni: " + strokes + " • punkte: " + points, Color.rgb(83, 96, 109));
    }

    private void setStatus(String message, int color) {
        if (status == null) return;
        status.setText(message == null ? "Allkirjastamine katkestati." : message);
        status.setTextColor(color);
    }

    private Button button(String label, View.OnClickListener listener) {
        Button button = new Button(activity);
        button.setText(label);
        button.setTextSize(12);
        button.setMinHeight(dp(48));
        button.setOnClickListener(listener);
        return button;
    }

    private LinearLayout.LayoutParams actionParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        params.setMargins(dp(2), 0, dp(2), 0);
        return params;
    }

    private TextView text(String value, float size, boolean bold, int color) {
        TextView text = new TextView(activity);
        text.setText(value);
        text.setTextSize(size);
        text.setTextColor(color);
        if (bold) text.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return text;
    }

    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
}
