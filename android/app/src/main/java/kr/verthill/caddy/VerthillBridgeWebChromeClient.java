package kr.verthill.caddy;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import androidx.core.content.FileProvider;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Image file-chooser intercept: HEIC/HEIF become cache JPEGs before WebView
 * sees them. On 자유게시판 / 가배치표 pages the same chooser also offers the
 * camera (ACTION_IMAGE_CAPTURE into an app-private cache file, no CAMERA
 * permission). Dialogs, permissions, fullscreen, and console stay on the parent.
 */
public class VerthillBridgeWebChromeClient extends BridgeWebChromeClient {

    static final int HQ_YIELD_MS = 64;

    private final Bridge bridge;
    private final ActivityResultLauncher<Intent> imagePickerLauncher;
    private final ExecutorService convertExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> pendingCallback;
    private int nativePreviewSession;
    private File pendingCameraFile;
    private Uri pendingCameraUri;

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
        if (fileChooserParams == null) {
            return super.onShowFileChooser(webView, filePathCallback, fileChooserParams);
        }
        if (fileChooserParams.isCaptureEnabled()) {
            return super.onShowFileChooser(webView, filePathCallback, fileChooserParams);
        }
        if (!HeicNativeJpegConverter.isImageOnlyAccept(fileChooserParams.getAcceptTypes())) {
            return super.onShowFileChooser(webView, filePathCallback, fileChooserParams);
        }

        HeicNativeJpegConverter.cleanupStale(bridge.getContext());
        if (pendingCallback != null) {
            pendingCallback.onReceiveValue(null);
            pendingCallback = null;
        }
        discardPendingCamera(true);
        cleanupStaleCameraFiles(bridge.getContext());
        pendingCallback = filePathCallback;
        nativePreviewSession += 1;

        Intent intent = fileChooserParams.createIntent();
        if (fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        applyAcceptMimeTypes(intent, fileChooserParams.getAcceptTypes());

        Intent launchIntent = intent;
        String pageUrl = webView != null ? webView.getUrl() : null;
        if (CameraChooserPolicy.allowsCameraForUrl(pageUrl)) {
            Intent capture = buildCameraCaptureIntent(bridge.getContext());
            if (capture != null) {
                launchIntent = Intent.createChooser(intent, null);
                launchIntent.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { capture });
            }
        }
        try {
            imagePickerLauncher.launch(launchIntent);
        } catch (RuntimeException e) {
            // Camera chooser could not start: fall back to the plain gallery / files picker.
            if (launchIntent != intent) {
                discardPendingCamera(true);
                try {
                    imagePickerLauncher.launch(intent);
                    return true;
                } catch (RuntimeException ignored) {
                    // fall through to cancel
                }
            }
            pendingCallback = null;
            filePathCallback.onReceiveValue(null);
        }
        return true;
    }

    /**
     * ACTION_IMAGE_CAPTURE writing into cache/camera-capture/ via FileProvider.
     * Returns null (gallery / files only) when no camera app or the file cannot be prepared.
     */
    private Intent buildCameraCaptureIntent(Context context) {
        if (context == null) return null;
        try {
            Intent capture = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            PackageManager pm = context.getPackageManager();
            List<ResolveInfo> cameras = pm.queryIntentActivities(capture, PackageManager.MATCH_DEFAULT_ONLY);
            if (cameras == null || cameras.isEmpty()) return null;
            File dir = new File(context.getCacheDir(), CameraChooserPolicy.CAMERA_DIR_NAME);
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            File file = new File(dir, CameraChooserPolicy.cameraFileName(System.currentTimeMillis()));
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            int grant = Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION;
            capture.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            capture.setClipData(ClipData.newRawUri("", uri));
            capture.addFlags(grant);
            for (ResolveInfo info : cameras) {
                if (info.activityInfo == null) continue;
                context.grantUriPermission(info.activityInfo.packageName, uri, grant);
            }
            pendingCameraFile = file;
            pendingCameraUri = uri;
            return capture;
        } catch (RuntimeException e) {
            discardPendingCamera(true);
            return null;
        }
    }

    /** Revoke the camera write grant; optionally delete the temp file. */
    private void discardPendingCamera(boolean deleteFile) {
        Uri uri = pendingCameraUri;
        File file = pendingCameraFile;
        pendingCameraUri = null;
        pendingCameraFile = null;
        revokeCameraGrant(uri);
        if (deleteFile && file != null) {
            // Best-effort.
            file.delete();
        }
    }

    private void revokeCameraGrant(Uri uri) {
        if (uri == null) return;
        try {
            bridge.getContext().revokeUriPermission(
                uri,
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
        } catch (RuntimeException ignored) {
            // Best-effort.
        }
    }

    private static void cleanupStaleCameraFiles(Context context) {
        if (context == null) return;
        File dir = new File(context.getCacheDir(), CameraChooserPolicy.CAMERA_DIR_NAME);
        File[] files = dir.listFiles();
        if (files == null) return;
        long now = System.currentTimeMillis();
        for (File file : files) {
            if (file.isFile() && CameraChooserPolicy.isStale(file.lastModified(), now)) {
                file.delete();
            }
        }
    }

    private void onImagePickerResult(ActivityResult result) {
        final ValueCallback<Uri[]> callback = pendingCallback;
        pendingCallback = null;
        final File cameraFile = pendingCameraFile;
        final Uri cameraUri = pendingCameraUri;
        pendingCameraFile = null;
        pendingCameraUri = null;
        revokeCameraGrant(cameraUri);
        if (callback == null) {
            if (cameraFile != null) cameraFile.delete();
            return;
        }
        boolean resultOk = result.getResultCode() == Activity.RESULT_OK;
        Uri[] returned = resultOk ? urisFromResult(result.getData()) : null;
        int returnedCount = countNonNull(returned);
        boolean returnedIsCameraOnly =
            cameraUri != null && returnedCount == 1 && cameraUri.equals(firstNonNull(returned));
        long cameraBytes = cameraFile != null && cameraFile.isFile() ? cameraFile.length() : 0L;
        CameraChooserPolicy.Source source =
            CameraChooserPolicy.decide(resultOk, returnedCount, returnedIsCameraOnly, cameraBytes);
        if (source != CameraChooserPolicy.Source.CAMERA && cameraFile != null) {
            // Gallery / files pick or cancel: the camera temp file is not used.
            cameraFile.delete();
        }
        if (source == CameraChooserPolicy.Source.CANCEL) {
            callback.onReceiveValue(null);
            return;
        }
        final Uri[] picked = source == CameraChooserPolicy.Source.CAMERA
            ? new Uri[] { cameraUri }
            : nonNull(returned);
        final Activity activity = bridge.getActivity();
        final int sessionId = nativePreviewSession;
        convertExecutor.execute(() -> {
            android.content.Context context = activity != null ? activity : bridge.getContext();
            Uri[] resolved = new Uri[picked.length];
            String[] previewIds = new String[picked.length];
            for (int i = 0; i < picked.length; i++) {
                HeicNativePreview.PreviewAttempt attempt =
                    HeicNativePreview.tryPreviewAttempt(context, picked[i], sessionId);
                HeicNativePreview.Preview preview = attempt.preview;
                if (preview != null) {
                    emitPreview(activity, preview, sessionId);
                    previewIds[i] = preview.previewId;
                    Uri written = HeicNativeJpegConverter.writeJpegBytes(
                        context,
                        preview.previewFileName(),
                        preview.jpeg
                    );
                    resolved[i] = written != null ? written : picked[i];
                } else {
                    resolved[i] = picked[i];
                }
            }
            scheduleChooserThenHq(
                activity,
                context,
                callback,
                resolved,
                picked,
                previewIds,
                sessionId
            );
        });
    }

    private void emitPreview(Activity activity, HeicNativePreview.Preview preview, int sessionId) {
        WebView webView = bridge.getWebView();
        if (activity == null || webView == null || preview == null) return;
        final String js = HeicNativePreview.previewJs(preview, sessionId);
        if (js == null) return;
        activity.runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }

    private void scheduleChooserThenHq(
        Activity activity,
        android.content.Context context,
        ValueCallback<Uri[]> callback,
        Uri[] resolved,
        Uri[] picked,
        String[] previewIds,
        int sessionId
    ) {
        Runnable hqTask = () -> convertHqAfterYield(activity, context, picked, previewIds, sessionId);
        if (activity == null) {
            callback.onReceiveValue(resolved);
            convertExecutor.execute(hqTask);
            return;
        }
        activity.runOnUiThread(() -> {
            callback.onReceiveValue(resolved);
            mainHandler.postDelayed(() -> convertExecutor.execute(hqTask), HQ_YIELD_MS);
        });
    }

    private void convertHqAfterYield(
        Activity activity,
        android.content.Context context,
        Uri[] picked,
        String[] previewIds,
        int sessionId
    ) {
        for (int i = 0; i < picked.length; i++) {
            if (previewIds[i] == null) continue;
            HeicNativeJpegConverter.ConvertResult converted =
                HeicNativeJpegConverter.resolveForWebView(
                    context,
                    picked[i],
                    previewIds[i] + ".jpg"
                );
            if (converted.outputWidth > 0 && converted.outputHeight > 0) {
                emitHqReady(activity, context, previewIds[i], sessionId, converted);
            } else {
                emitHqFailed(activity, previewIds[i], sessionId);
            }
        }
    }

    private void emitHqReady(
        Activity activity,
        android.content.Context context,
        String previewId,
        int sessionId,
        HeicNativeJpegConverter.ConvertResult converted
    ) {
        WebView webView = bridge.getWebView();
        if (activity == null || webView == null || previewId == null) return;
        final String js = HeicNativePreview.hqReadyJs(
            context,
            previewId,
            sessionId,
            converted.outputWidth,
            converted.outputHeight
        );
        if (js == null) {
            emitHqFailed(activity, previewId, sessionId);
            return;
        }
        activity.runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }

    private void emitHqFailed(Activity activity, String previewId, int sessionId) {
        WebView webView = bridge.getWebView();
        if (activity == null || webView == null || previewId == null) return;
        final String js = HeicNativePreview.hqFailedJs(previewId, sessionId);
        if (js == null) return;
        activity.runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }

    private static int countNonNull(Uri[] uris) {
        if (uris == null) return 0;
        int count = 0;
        for (Uri uri : uris) {
            if (uri != null) count += 1;
        }
        return count;
    }

    private static Uri firstNonNull(Uri[] uris) {
        if (uris == null) return null;
        for (Uri uri : uris) {
            if (uri != null) return uri;
        }
        return null;
    }

    private static Uri[] nonNull(Uri[] uris) {
        Uri[] out = new Uri[countNonNull(uris)];
        int i = 0;
        if (uris != null) {
            for (Uri uri : uris) {
                if (uri != null) out[i++] = uri;
            }
        }
        return out;
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
