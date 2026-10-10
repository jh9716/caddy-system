package kr.verthill.caddy;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.SystemClock;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.Toast;
import org.json.JSONObject;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Image file-chooser intercept: HEIC/HEIF become cache JPEGs before WebView
 * sees them. Dialogs, permissions, fullscreen, and console stay on the parent.
 */
public class VerthillBridgeWebChromeClient extends BridgeWebChromeClient {

    private final Bridge bridge;
    private final ActivityResultLauncher<Intent> imagePickerLauncher;
    private final ExecutorService convertExecutor = Executors.newSingleThreadExecutor();
    private ValueCallback<Uri[]> pendingCallback;
    private int nativePreviewSession;

    public VerthillBridgeWebChromeClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
        HeicNativeJpegConverter.cleanupStale(bridge.getContext());
        this.imagePickerLauncher = bridge.registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            this::onImagePickerResult
        );
    }

    @Override
    public boolean onShowFileChooser(
        WebView webView,
        ValueCallback<Uri[]> filePathCallback,
        FileChooserParams fileChooserParams
    ) {
        if (
            fileChooserParams == null ||
            fileChooserParams.isCaptureEnabled() ||
            !HeicNativeJpegConverter.isImageOnlyAccept(fileChooserParams.getAcceptTypes())
        ) {
            return super.onShowFileChooser(webView, filePathCallback, fileChooserParams);
        }

        HeicNativeJpegConverter.cleanupStale(bridge.getContext());
        if (pendingCallback != null) {
            pendingCallback.onReceiveValue(null);
            pendingCallback = null;
        }
        pendingCallback = filePathCallback;
        nativePreviewSession += 1;

        Intent intent = fileChooserParams.createIntent();
        if (fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        applyAcceptMimeTypes(intent, fileChooserParams.getAcceptTypes());
        try {
            imagePickerLauncher.launch(intent);
        } catch (ActivityNotFoundException e) {
            pendingCallback = null;
            filePathCallback.onReceiveValue(null);
        }
        return true;
    }

    private void onImagePickerResult(ActivityResult result) {
        final ValueCallback<Uri[]> callback = pendingCallback;
        pendingCallback = null;
        if (callback == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            callback.onReceiveValue(null);
            return;
        }
        final Uri[] picked = urisFromResult(result.getData());
        if (picked == null || picked.length == 0) {
            callback.onReceiveValue(null);
            return;
        }
        final Activity activity = bridge.getActivity();
        final int sessionId = nativePreviewSession;
        convertExecutor.execute(() -> {
            android.content.Context context = activity != null ? activity : bridge.getContext();
            Uri[] resolved = new Uri[picked.length];
            String[] previewIds = new String[picked.length];
            int lastW = 0;
            int lastH = 0;
            String lastMeta = "";
            long previewWall = 0L;
            long hqWall = 0L;

            long previewStarted = SystemClock.elapsedRealtime();
            for (int i = 0; i < picked.length; i++) {
                HeicNativePreview.Preview preview = HeicNativePreview.tryPreview(context, picked[i], sessionId);
                if (preview != null) {
                    previewIds[i] = preview.previewId;
                    emitPreview(activity, preview, sessionId);
                    lastW = preview.width;
                    lastH = preview.height;
                }
            }
            previewWall = SystemClock.elapsedRealtime() - previewStarted;

            long hqStarted = SystemClock.elapsedRealtime();
            for (int i = 0; i < picked.length; i++) {
                String outputName = previewIds[i] != null ? previewIds[i] + ".jpg" : null;
                HeicNativeJpegConverter.ConvertResult converted =
                    HeicNativeJpegConverter.resolveForWebView(context, picked[i], outputName);
                resolved[i] = converted.uri;
                if (converted.outputWidth > 0 && converted.outputHeight > 0) {
                    lastW = converted.outputWidth;
                    lastH = converted.outputHeight;
                    String metaLabel = converted.meta.toastLabel();
                    if (!metaLabel.isEmpty()) lastMeta = metaLabel;
                }
            }
            hqWall = SystemClock.elapsedRealtime() - hqStarted;

            List<String> debugToasts = new ArrayList<>();
            if (isDebugApk(context) && lastW > 0) {
                debugToasts.add(
                    "preview " +
                    previewWall +
                    "ms · HQ " +
                    hqWall +
                    "ms" +
                    (lastMeta.isEmpty() ? "" : " · " + lastMeta) +
                    " · " +
                    lastW +
                    "x" +
                    lastH
                );
            }
            deliver(activity, callback, resolved, debugToasts);
        });
    }

    private void emitPreview(Activity activity, HeicNativePreview.Preview preview, int sessionId) {
        if (activity == null || preview == null) return;
        WebView webView = bridge.getWebView();
        if (webView == null) return;
        try {
            JSONObject detail = new JSONObject();
            detail.put("previewId", preview.previewId);
            detail.put("sessionId", String.valueOf(sessionId));
            detail.put("mime", "image/jpeg");
            detail.put("width", preview.width);
            detail.put("height", preview.height);
            detail.put("bytes", preview.bytes);
            detail.put("dataUrl", preview.dataUrl);
            final String js =
                "window.dispatchEvent(new CustomEvent('" +
                HeicNativePreview.EVENT +
                "',{detail:" +
                detail.toString() +
                "}));";
            activity.runOnUiThread(() -> webView.evaluateJavascript(js, null));
        } catch (Exception ignored) {
            // Preview is optional. HQ callback still proceeds.
        }
    }

    private static void deliver(
        Activity activity,
        ValueCallback<Uri[]> callback,
        Uri[] uris,
        List<String> debugToasts
    ) {
        if (activity == null) {
            callback.onReceiveValue(uris);
            return;
        }
        activity.runOnUiThread(() -> {
            callback.onReceiveValue(uris);
            if (!isDebugApk(activity) || debugToasts == null || debugToasts.isEmpty()) {
                return;
            }
            StringBuilder message = new StringBuilder();
            for (int i = 0; i < debugToasts.size(); i++) {
                if (i > 0) message.append('\n');
                message.append(debugToasts.get(i));
            }
            Toast.makeText(activity, message.toString(), Toast.LENGTH_LONG).show();
        });
    }

    /** Debug APK only. Release builds do not show HEIC timing toasts. */
    static boolean isDebugApk(android.content.Context context) {
        if (context == null) return false;
        return (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    static Uri[] urisFromResult(Intent data) {
        if (data == null) return null;
        if (data.getClipData() != null) {
            int count = data.getClipData().getItemCount();
            Uri[] uris = new Uri[count];
            for (int i = 0; i < count; i++) {
                uris[i] = data.getClipData().getItemAt(i).getUri();
            }
            return uris;
        }
        if (data.getData() != null) {
            return new Uri[] { data.getData() };
        }
        return WebChromeClient.FileChooserParams.parseResult(Activity.RESULT_OK, data);
    }

    private static void applyAcceptMimeTypes(Intent intent, String[] acceptTypes) {
        if (acceptTypes == null || acceptTypes.length == 0) return;
        String type = intent.getType();
        if (acceptTypes.length <= 1 && (type == null || !type.startsWith("."))) return;
        MimeTypeMap mimeTypeMap = MimeTypeMap.getSingleton();
        List<String> validTypes = new ArrayList<>();
        for (String mime : acceptTypes) {
            if (mime == null || mime.isEmpty()) continue;
            if (mime.startsWith(".")) {
                String fromExt = mimeTypeMap.getMimeTypeFromExtension(mime.substring(1));
                if (fromExt != null && !validTypes.contains(fromExt)) validTypes.add(fromExt);
            } else if (!validTypes.contains(mime)) {
                validTypes.add(mime);
            }
        }
        if (validTypes.isEmpty()) return;
        intent.putExtra(Intent.EXTRA_MIME_TYPES, validTypes.toArray(new String[0]));
        if (type != null && type.startsWith(".")) {
            intent.setType(validTypes.get(0));
        }
    }
}
