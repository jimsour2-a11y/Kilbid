package ee.dold.techcontrol;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.SystemClock;
import android.provider.DocumentsContract;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.core.content.FileProvider;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.ResultPoint;
import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import com.journeyapps.barcodescanner.BarcodeView;
import com.journeyapps.barcodescanner.DefaultDecoderFactory;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.List;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1101;
    private static final int CAMERA_PERMISSION_REQUEST = 1102;
    private static final int EXPORT_DOCUMENT_REQUEST = 1103;
    private WorkspaceStore workspaceStore;
    private boolean darkTheme = false;
    private volatile String lastCameraId;
    private volatile long lastCameraAt;
    private Uri importUri;
    private boolean exportWaiting = false;
    private final ExecutorService exportWorker = Executors.newSingleThreadExecutor();

    private FrameLayout rootLayout;
    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;

    private FrameLayout scannerOverlay;
    private BarcodeView barcodeView;
    private boolean scannerActive = false;

    private File pendingExportFile;
    private FileOutputStream pendingExportStream;
    private String pendingExportName;
    private String pendingExportMime;
    private File pendingShareFile;
    private FileOutputStream pendingShareStream;
    private String pendingShareMime;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        workspaceStore = new WorkspaceStore(getFilesDir());
        String savedUri = getPreferences(MODE_PRIVATE).getString("importUri", null);
        if (savedUri != null) importUri = Uri.parse(savedUri);
        setLightSystemBars();

        rootLayout = new FrameLayout(this);
        webView = new WebView(this);
        // Keep the known-working v0.5.2 startup path. The v0.5.3 inset listener
        // ran during onCreate before WebView loaded and could terminate the
        // Activity on Android 16. Safe-area handling is intentionally isolated
        // from startup until it can be verified on a real device.
        if (Build.VERSION.SDK_INT >= 35) {
            webView.setPadding(0, getStatusBarHeight(), 0, 0);
        }
        rootLayout.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        setContentView(rootLayout);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setDatabaseEnabled(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);

        webView.addJavascriptInterface(new AndroidBridge(), "Android");
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                // Native storage/QR bridge is only available to our packaged UI.
                return !request.getUrl().toString().startsWith("file:///android_asset/");
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView webView,
                    ValueCallback<Uri[]> filePathCallbackNew,
                    FileChooserParams fileChooserParams
            ) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = filePathCallbackNew;

                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.dold.techcontrol.workpackage", "application/zip", "application/octet-stream", "image/*"});
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                if (importUri != null) intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, importUri);

                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "Failivalijat ei saanud avada", Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });

        webView.loadUrl("file:///android_asset/index.html");
    }

    private void setLightSystemBars() {
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            getWindow().getDecorView().setSystemUiVisibility(
                    ViewGroup.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
            );
        }
    }

    private int getStatusBarHeight() {
        int resourceId = getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (resourceId > 0) {
            return getResources().getDimensionPixelSize(resourceId);
        }
        return dp(28);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }


    /**
     * QR camera is rendered inside this Activity as an overlay over the WebView.
     * This avoids switching to another scanner Activity / external app.
     */
    private void showQrScanner() {
        if (scannerActive || rootLayout == null) return;

        scannerActive = true;
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            getWindow().getDecorView().setSystemUiVisibility(0);
        }

        scannerOverlay = new FrameLayout(this);
        scannerOverlay.setBackgroundColor(Color.BLACK);

        barcodeView = new BarcodeView(this);
        barcodeView.setDecoderFactory(new DefaultDecoderFactory(
                Collections.singletonList(BarcodeFormat.QR_CODE)
        ));
        scannerOverlay.addView(barcodeView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        // Simple scan frame. It is only a visual guide; the decoder scans the full preview.
        FrameLayout scanFrame = new FrameLayout(this);
        GradientDrawable frameBg = new GradientDrawable();
        frameBg.setColor(Color.TRANSPARENT);
        frameBg.setStroke(dp(3), Color.WHITE);
        frameBg.setCornerRadius(dp(14));
        scanFrame.setBackground(frameBg);
        FrameLayout.LayoutParams frameParams = new FrameLayout.LayoutParams(dp(260), dp(260));
        frameParams.gravity = Gravity.CENTER;
        scannerOverlay.addView(scanFrame, frameParams);

        TextView prompt = new TextView(this);
        prompt.setText("Skaneeri elektrikilbi QR-kood");
        prompt.setTextColor(Color.WHITE);
        prompt.setTextSize(19);
        prompt.setGravity(Gravity.CENTER);
        prompt.setPadding(dp(16), dp(16), dp(16), dp(16));
        FrameLayout.LayoutParams promptParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        promptParams.gravity = Gravity.TOP;
        promptParams.topMargin = dp(24);
        promptParams.leftMargin = dp(20);
        promptParams.rightMargin = dp(20);
        scannerOverlay.addView(prompt, promptParams);

        Button cancel = new Button(this);
        cancel.setText("TÜHISTA");
        cancel.setTextSize(16);
        cancel.setOnClickListener(v -> closeQrScanner(false));
        FrameLayout.LayoutParams cancelParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        cancelParams.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        cancelParams.bottomMargin = dp(32);
        scannerOverlay.addView(cancel, cancelParams);

        rootLayout.addView(scannerOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        BarcodeCallback callback = new BarcodeCallback() {
            @Override
            public void barcodeResult(BarcodeResult result) {
                if (!scannerActive || result == null || result.getText() == null || result.getText().trim().isEmpty()) {
                    return;
                }
                String text = result.getText();
                java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\\bEK-\\d{3,}\\b").matcher(text.toUpperCase(java.util.Locale.ROOT));
                lastCameraId = matcher.find() ? matcher.group() : null;
                lastCameraAt = SystemClock.elapsedRealtime();
                runOnUiThread(() -> {
                    closeQrScanner(true);
                    sendQrResultToWeb(text);
                });
            }

            @Override
            public void possibleResultPoints(List<ResultPoint> resultPoints) {
                // No UI action needed.
            }
        };

        barcodeView.decodeSingle(callback);
        barcodeView.resume();
    }

    private void closeQrScanner(boolean success) {
        if (!scannerActive && scannerOverlay == null) return;

        scannerActive = false;
        try {
            if (barcodeView != null) barcodeView.pause();
        } catch (Exception ignored) {
        }

        if (rootLayout != null && scannerOverlay != null) {
            rootLayout.removeView(scannerOverlay);
        }
        barcodeView = null;
        scannerOverlay = null;
        setLightSystemBars();

        if (!success) {
            // Cancellation is normal. Do not show an error toast.
        }
    }

    private void requestOrLaunchQrScanner() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[]{Manifest.permission.CAMERA},
                    CAMERA_PERMISSION_REQUEST
            );
        } else {
            showQrScanner();
        }
    }

    private void sendQrResultToWeb(String value) {
        if (value == null) return;
        String js = "window.onNativeQrResult(" + JSONObject.quote(value) + ");";
        webView.evaluateJavascript(js, null);
    }

    private void sendQrErrorToWeb(String value) {
        String js = "window.onNativeQrError(" + JSONObject.quote(value == null ? "" : value) + ");";
        webView.evaluateJavascript(js, null);
    }

    private void sendExportResult(boolean ok, String message) {
        runOnUiThread(() -> {
            String js = "window.onNativeExportFinished(" + (ok ? "true" : "false") + "," +
                    JSONObject.quote(message == null ? "" : message) + ");";
            webView.evaluateJavascript(js, null);
        });
    }

    private void sendShareResult(boolean ok, String message) {
        runOnUiThread(() -> {
            String js = "window.onNativeShareFinished(" + (ok ? "true" : "false") + "," +
                    JSONObject.quote(message == null ? "" : message) + ");";
            webView.evaluateJavascript(js, null);
        });
    }

    private synchronized boolean beginShare(String fileName, String mime) {
        try {
            closePendingShareQuietly();
            File directory = new File(getCacheDir(), "shared");
            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Jagamise kausta ei saa luua");
            String safeName = sanitizeShareFileName(fileName);
            pendingShareFile = new File(directory, "share_" + System.currentTimeMillis() + "_" + safeName);
            pendingShareMime = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
            pendingShareStream = new FileOutputStream(pendingShareFile);
            return true;
        } catch (Exception e) {
            closePendingShareQuietly();
            sendShareResult(false, e.getMessage());
            return false;
        }
    }

    private synchronized boolean appendShareChunk(String base64Chunk) {
        try {
            if (pendingShareStream == null) throw new IllegalStateException("Jagatav fail pole ette valmistatud");
            pendingShareStream.write(Base64.decode(base64Chunk, Base64.DEFAULT));
            return true;
        } catch (Exception e) {
            closePendingShareQuietly();
            sendShareResult(false, e.getMessage());
            return false;
        }
    }

    private synchronized boolean finishShare() {
        try {
            if (pendingShareStream == null || pendingShareFile == null) throw new IllegalStateException("Jagatav fail puudub");
            pendingShareStream.flush(); pendingShareStream.getFD().sync(); pendingShareStream.close(); pendingShareStream = null;
            final File file = pendingShareFile;
            final String mime = pendingShareMime;
            pendingShareFile = null; pendingShareMime = null;
            runOnUiThread(() -> {
                try {
                    Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", file);
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType(mime); send.putExtra(Intent.EXTRA_STREAM, uri);
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    Intent chooser = Intent.createChooser(send, "Jaga DOLD TechControli tööfaili");
                    chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(chooser);
                    sendShareResult(true, "Androidi jagamismenüü avati");
                } catch (Exception e) {
                    sendShareResult(false, e.getMessage());
                }
            });
            return true;
        } catch (Exception e) {
            closePendingShareQuietly();
            sendShareResult(false, e.getMessage());
            return false;
        }
    }

    private synchronized void closePendingShareQuietly() {
        try { if (pendingShareStream != null) pendingShareStream.close(); } catch (Exception ignored) {}
        pendingShareStream = null;
        if (pendingShareFile != null && pendingShareFile.exists()) pendingShareFile.delete();
        pendingShareFile = null; pendingShareMime = null;
    }

    private String sanitizeShareFileName(String name) {
        String safe = name == null ? "DOLD_TechControl.xlsx" : name;
        safe = safe.replaceAll("[\\\\/:*?\"<>|]", "_");
        return safe.isEmpty() ? "DOLD_TechControl.xlsx" : safe;
    }

    private synchronized void beginExport(String fileName, String mime) throws Exception {
        if (exportWaiting) throw new IllegalStateException("Eksport on juba pooleli");
        closePendingExportQuietly();

        pendingExportName = sanitizeFileName(fileName);
        pendingExportMime = (mime == null || mime.isEmpty())
                ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                : mime;

        pendingExportFile = new File(getCacheDir(), "export_" + System.currentTimeMillis() + ".tmp");
        pendingExportStream = new FileOutputStream(pendingExportFile);
    }

    private synchronized void appendExportChunk(String base64Chunk) throws Exception {
        if (pendingExportStream == null) {
            throw new IllegalStateException("Export is not started");
        }
        byte[] bytes = Base64.decode(base64Chunk, Base64.DEFAULT);
        pendingExportStream.write(bytes);
    }

    private synchronized void finishExport() {
        try {
            if (pendingExportStream == null) throw new IllegalStateException("Eksport ei ole alustatud");
            pendingExportStream.flush();pendingExportStream.getFD().sync();pendingExportStream.close();pendingExportStream=null;
            exportWaiting=true;
            runOnUiThread(() -> {
                Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType(pendingExportMime);
                intent.putExtra(Intent.EXTRA_TITLE,pendingExportName);
                // A document URI makes the picker start in its parent when supported.
                // OPEN_DOCUMENT grants access to one file, never permission to invent a parent URI.
                if(importUri!=null)intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI,importUri);
                try { startActivityForResult(intent,EXPORT_DOCUMENT_REQUEST); }
                catch(Exception e) { exportWorker.execute(this::exportToDownloads); }
            });
        } catch(Exception e) {closePendingExportQuietly();sendExportResult(false,e.getMessage());}
    }

    private synchronized void writeExportDocument(Uri destination) {
        try {
            if(destination==null || pendingExportFile==null)throw new IllegalStateException("Ekspordi siht puudub");
            if(destination.equals(importUri))throw new IllegalStateException("Algfaili üle kirjutamine on keelatud");
            try(FileInputStream in=new FileInputStream(pendingExportFile);OutputStream out=getContentResolver().openOutputStream(destination,"w")){
                if(out==null)throw new IllegalStateException("Sihtfaili ei saa avada");
                byte[] buf=new byte[65536];int count;while((count=in.read(buf))!=-1)out.write(buf,0,count);out.flush();
            }
            String name=pendingExportName;closePendingExportQuietly();sendExportResult(true,"XLSX koopia salvestatud: "+name);
        }catch(Exception e){closePendingExportQuietly();sendExportResult(false,e.getMessage());}
    }

    private synchronized void exportToDownloads() {
        try {
            if (pendingExportFile == null) throw new IllegalStateException("Export is not started");

            String destination;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, pendingExportName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, pendingExportMime);
                values.put(
                        MediaStore.MediaColumns.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/Kilbikontroll"
                );
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);

                Uri uri = getContentResolver().insert(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        values
                );
                if (uri == null) {
                    throw new IllegalStateException("Downloads faili ei saanud luua");
                }

                try (FileInputStream in = new FileInputStream(pendingExportFile);
                     OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) {
                        throw new IllegalStateException("Downloads faili ei saanud avada");
                    }
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                    }
                }

                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(uri, done, null, null);
                destination = "Downloads/Kilbikontroll/" + pendingExportName;
            } else {
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) {
                    throw new IllegalStateException("Downloads kaust pole saadaval");
                }
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new IllegalStateException("Downloads kausta ei saanud luua");
                }
                File outFile = new File(dir, pendingExportName);
                try (FileInputStream in = new FileInputStream(pendingExportFile);
                     FileOutputStream out = new FileOutputStream(outFile)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                    }
                }
                destination = outFile.getAbsolutePath();
            }

            if (pendingExportFile.exists()) {
                pendingExportFile.delete();
            }

            pendingExportFile = null;
            pendingExportName = null;
            pendingExportMime = null;

            exportWaiting=false;
            sendExportResult(true, "Failivalija puudus. XLSX salvestatud: " + destination);
        } catch (Exception e) {
            closePendingExportQuietly();
            sendExportResult(false, e.getMessage());
        }
    }

    private synchronized void closePendingExportQuietly() {
        exportWaiting=false;
        try {
            if (pendingExportStream != null) {
                pendingExportStream.close();
            }
        } catch (Exception ignored) {
        }
        pendingExportStream = null;

        if (pendingExportFile != null && pendingExportFile.exists()) {
            pendingExportFile.delete();
        }
        pendingExportFile = null;
    }

    private String sanitizeFileName(String name) {
        String safe = name == null ? "Kilbikontroll.xlsx" : name;
        safe = safe.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (!safe.toLowerCase().endsWith(".xlsx")) {
            safe += ".xlsx";
        }
        return safe;
    }

    public class AndroidBridge {
        @JavascriptInterface public String saveWorkspace(String id,String payload){try{workspaceStore.save(id,payload);return WorkspaceStore.ok(true);}catch(Exception e){return WorkspaceStore.error(e);}}
        @JavascriptInterface public String readWorkspace(String id){try{return WorkspaceStore.ok(workspaceStore.read(id));}catch(Exception e){return WorkspaceStore.error(e);}}
        @JavascriptInterface public String listWorkspaces(){try{return WorkspaceStore.ok(workspaceStore.list());}catch(Exception e){return WorkspaceStore.error(e);}}
        @JavascriptInterface public String listWorkspaceErrors(){try{return WorkspaceStore.ok(workspaceStore.listErrors());}catch(Exception e){return WorkspaceStore.error(e);}}
        @JavascriptInterface public String hashBytes(String base64){try{return WorkspaceStore.hash(Base64.decode(base64,Base64.DEFAULT));}catch(Exception e){throw new IllegalStateException(e);}}
        @JavascriptInterface public long elapsedRealtime(){return SystemClock.elapsedRealtime();}
        @JavascriptInterface public void setTheme(boolean dark){runOnUiThread(()->{darkTheme=dark;if(!scannerActive)setLightSystemBars();});}
        @JavascriptInterface public boolean beginShareFile(String fileName,String mime){return beginShare(fileName,mime);}
        @JavascriptInterface public boolean writeShareChunk(String base64Chunk){return appendShareChunk(base64Chunk);}
        @JavascriptInterface public boolean finishShareFile(){return finishShare();}
        @JavascriptInterface public synchronized boolean consumeQrProof(String id){
            boolean valid=id!=null&&id.equals(lastCameraId)&&SystemClock.elapsedRealtime()-lastCameraAt<120000;
            lastCameraId=null;return valid;
        }

        @JavascriptInterface
        public void scanQr() {
            runOnUiThread(MainActivity.this::requestOrLaunchQrScanner);
        }

        @JavascriptInterface
        public void beginSaveFile(String fileName, String mime) {
            try {
                beginExport(fileName, mime);
            } catch (Exception e) {
                sendExportResult(false, e.getMessage());
            }
        }

        @JavascriptInterface
        public void writeSaveChunk(String base64Chunk) {
            try {
                appendExportChunk(base64Chunk);
            } catch (Exception e) {
                sendExportResult(false, e.getMessage());
            }
        }

        @JavascriptInterface
        public void finishSaveFile() {
            finishExport();
        }

        @JavascriptInterface
        public String getAppVersion() {
            return "0.5.5";
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if(requestCode==EXPORT_DOCUMENT_REQUEST){
            if(resultCode==Activity.RESULT_OK&&data!=null&&data.getData()!=null){Uri uri=data.getData();exportWorker.execute(()->writeExportDocument(uri));}
            else {closePendingExportQuietly();sendExportResult(false,"Eksport tühistatud");}
            return;
        }
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == Activity.RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        results = new Uri[]{data.getData()};
                    }
                }
                if(results!=null&&results.length>0){
                    Uri candidate=results[0];String mime=getContentResolver().getType(candidate);
                    if(mime==null||!mime.startsWith("image/")){
                        importUri=candidate;getPreferences(MODE_PRIVATE).edit().putString("importUri",candidate.toString()).commit();
                        try{getContentResolver().takePersistableUriPermission(candidate,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Exception ignored){}
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }

        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            String[] permissions,
            int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                showQrScanner();
            } else {
                sendQrErrorToWeb("Kaamera luba puudub");
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (scannerActive && barcodeView != null) {
            try {
                barcodeView.resume();
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    protected void onPause() {
        if (barcodeView != null) {
            try {
                barcodeView.pause();
            } catch (Exception ignored) {
            }
        }
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (scannerActive) {
            closeQrScanner(false);
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        closeQrScanner(false);
        closePendingExportQuietly();
        if (webView != null) {
            webView.destroy();
        }
        exportWorker.shutdown();
        super.onDestroy();
    }
}
