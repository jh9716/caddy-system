package kr.verthill.caddy;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
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
        convertExecutor.execute(() -> {
            Uri[] resolved = new Uri[picked.length];
            for (int i = 0; i < picked.length; i++) {
                resolved[i] = HeicNativeJpegConverter.resolveForWebView(
                    activity != null ? activity : bridge.getContext(),
                    picked[i]
                );
            }
            deliver(activity, callback, resolved);
        });
    }

    private static void deliver(Activity activity, ValueCallback<Uri[]> callback, Uri[] uris) {
        if (activity == null) {
            callback.onReceiveValue(uris);
            return;
        }
        activity.runOnUiThread(() -> callback.onReceiveValue(uris));
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
