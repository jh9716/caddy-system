package kr.verthill.caddy;

import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Size;
import java.util.Locale;
import java.util.UUID;

/**
 * Instant HEIC preview only. Never the upload JPEG.
 * Uses provider loadThumbnail (~384x512) and a cache JPEG for the chooser.
 */
final class HeicNativePreview {

    static final String EVENT = "verthill:chat-photo-native-preview";
    static final String HQ_EVENT = "verthill:chat-photo-native-hq-ready";
    static final int PREVIEW_EDGE = 512;
    static final int PREVIEW_JPEG_QUALITY = 70;

    private HeicNativePreview() {}

    static final class Preview {
        final String previewId;
        final byte[] jpeg;
        final int width;
        final int height;
        final int bytes;
        final long previewMs;

        Preview(String previewId, byte[] jpeg, int width, int height, int bytes, long previewMs) {
            this.previewId = previewId;
            this.jpeg = jpeg;
            this.width = width;
            this.height = height;
            this.bytes = bytes;
            this.previewMs = previewMs;
        }

        String previewFileName() {
            return previewId + "-preview.jpg";
        }
    }

    /**
     * Why tryPreview returned a JPEG or null. Never stores URI/path/bytes.
     */
    static final class PreviewAttempt {
        static final String SUCCESS = "success";
        static final String NOT_HEIC = "not_heic";
        static final String SDK_LT_29 = "sdk_lt_29";
        static final String LOAD_THUMBNAIL_NULL = "loadThumbnail_null";
        static final String LOAD_THUMBNAIL_EXCEPTION_PREFIX = "loadThumbnail_exception:";
        static final String JPEG_COMPRESS_FAIL = "jpeg_compress_fail";
        static final String JPEG_EMPTY = "jpeg_empty";

        final Preview preview;
        final String reason;
        final String mime;
        final String nameExt;
        final boolean heicLike;
        final int sdk;

        PreviewAttempt(
            Preview preview,
            String reason,
            String mime,
            String nameExt,
            boolean heicLike,
            int sdk
        ) {
            this.preview = preview;
            this.reason = reason;
            this.mime = mime;
            this.nameExt = nameExt;
            this.heicLike = heicLike;
            this.sdk = sdk;
        }

        boolean ok() {
            return preview != null && SUCCESS.equals(reason);
        }

        String failToast() {
            return (
                "nativePreview FAIL · " +
                reason +
                " · mime=" +
                mime +
                " · name=" +
                nameExt
            );
        }
    }

    static String newPreviewId(int sessionId) {
        return "nvp-" + sessionId + "-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    }

    /** Extension only (`.heic`). Never a path, URI, or full display name. */
    static String extensionOf(String displayName) {
        if (displayName == null || displayName.isEmpty()) return "none";
        String base = displayName;
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0 && slash + 1 < base.length()) {
            base = base.substring(slash + 1);
        } else if (slash >= 0) {
            return "none";
        }
        int dot = base.lastIndexOf('.');
        if (dot < 0 || dot >= base.length() - 1) return "none";
        String ext = base.substring(dot).toLowerCase(Locale.US);
        if (ext.length() > 8) return "none";
        for (int i = 1; i < ext.length(); i++) {
            char c = ext.charAt(i);
            if ((c < 'a' || c > 'z') && (c < '0' || c > '9')) return "none";
        }
        return ext;
    }

    static String safeMimeLabel(String mime) {
        if (mime == null || mime.trim().isEmpty()) return "unknown";
        String trimmed = mime.trim().toLowerCase(Locale.US);
        if (trimmed.length() > 64) return "unknown";
        if (
            trimmed.contains("://") ||
            trimmed.contains("content:") ||
            trimmed.contains("file:") ||
            trimmed.contains("..")
        ) {
            return "unknown";
        }
        return trimmed;
    }

    static String exceptionReason(Exception error) {
        String simple = error == null ? "Exception" : error.getClass().getSimpleName();
        if (simple == null || simple.isEmpty()) simple = "Exception";
        return PreviewAttempt.LOAD_THUMBNAIL_EXCEPTION_PREFIX + simple;
    }

    static Preview tryPreview(Context context, Uri uri, int sessionId) {
        return tryPreviewAttempt(context, uri, sessionId).preview;
    }

    static PreviewAttempt tryPreviewAttempt(Context context, Uri uri, int sessionId) {
        int sdk = Build.VERSION.SDK_INT;
        String mime = null;
        String displayName = null;
        if (context != null && uri != null) {
            mime = HeicNativeJpegConverter.mimeOf(context, uri);
            displayName = HeicNativeJpegConverter.displayNameOf(context, uri);
        }
        String nameExt = extensionOf(displayName);
        String mimeLabel = safeMimeLabel(mime);
        boolean heicLike = HeicNativeJpegConverter.isHeicLike(mime, displayName);
        if (context == null || uri == null) {
            return new PreviewAttempt(null, PreviewAttempt.NOT_HEIC, mimeLabel, nameExt, false, sdk);
        }
        if (sdk < 29) {
            return new PreviewAttempt(null, PreviewAttempt.SDK_LT_29, mimeLabel, nameExt, heicLike, sdk);
        }
        if (!heicLike) {
            return new PreviewAttempt(null, PreviewAttempt.NOT_HEIC, mimeLabel, nameExt, false, sdk);
        }
        Bitmap bitmap = null;
        long started = SystemClock.elapsedRealtime();
        try {
            bitmap = context.getContentResolver().loadThumbnail(
                uri,
                new Size(PREVIEW_EDGE, PREVIEW_EDGE),
                null
            );
            if (bitmap == null || bitmap.getWidth() < 1 || bitmap.getHeight() < 1) {
                return new PreviewAttempt(
                    null,
                    PreviewAttempt.LOAD_THUMBNAIL_NULL,
                    mimeLabel,
                    nameExt,
                    true,
                    sdk
                );
            }
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, PREVIEW_JPEG_QUALITY, output)) {
                return new PreviewAttempt(
                    null,
                    PreviewAttempt.JPEG_COMPRESS_FAIL,
                    mimeLabel,
                    nameExt,
                    true,
                    sdk
                );
            }
            byte[] jpeg = output.toByteArray();
            if (jpeg.length <= 0) {
                return new PreviewAttempt(
                    null,
                    PreviewAttempt.JPEG_EMPTY,
                    mimeLabel,
                    nameExt,
                    true,
                    sdk
                );
            }
            return new PreviewAttempt(
                new Preview(
                    newPreviewId(sessionId),
                    jpeg,
                    bitmap.getWidth(),
                    bitmap.getHeight(),
                    jpeg.length,
                    SystemClock.elapsedRealtime() - started
                ),
                PreviewAttempt.SUCCESS,
                mimeLabel,
                nameExt,
                true,
                sdk
            );
        } catch (Exception error) {
            return new PreviewAttempt(null, exceptionReason(error), mimeLabel, nameExt, true, sdk);
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }

    static String previewJs(Preview preview, int sessionId) {
        if (preview == null || preview.jpeg == null || preview.jpeg.length <= 0) return null;
        if (preview.previewId == null || preview.previewId.isEmpty()) return null;
        org.json.JSONObject detail = new org.json.JSONObject();
        try {
            detail.put("previewId", preview.previewId);
            detail.put("sessionId", String.valueOf(sessionId));
            detail.put("mime", "image/jpeg");
            detail.put("width", preview.width);
            detail.put("height", preview.height);
            detail.put("bytes", preview.bytes);
            detail.put(
                "dataUrl",
                "data:image/jpeg;base64," + Base64.encodeToString(preview.jpeg, Base64.NO_WRAP)
            );
        } catch (Exception ignored) {
            return null;
        }
        return (
            "window.dispatchEvent(new CustomEvent('" +
            EVENT +
            "',{detail:" +
            detail.toString() +
            "}));"
        );
    }

    static String hqReadyJs(
        Context context,
        String previewId,
        int sessionId,
        int width,
        int height
    ) {
        byte[] jpeg = HeicNativeJpegConverter.readCacheJpeg(context, previewId + ".jpg");
        if (jpeg == null || jpeg.length <= 0) return null;
        org.json.JSONObject detail = new org.json.JSONObject();
        try {
            detail.put("previewId", previewId);
            detail.put("sessionId", String.valueOf(sessionId));
            detail.put("mime", "image/jpeg");
            detail.put("width", width);
            detail.put("height", height);
            detail.put("bytes", jpeg.length);
            detail.put(
                "dataUrl",
                "data:image/jpeg;base64," + Base64.encodeToString(jpeg, Base64.NO_WRAP)
            );
        } catch (Exception ignored) {
            return null;
        }
        return (
            "window.dispatchEvent(new CustomEvent('" +
            HQ_EVENT +
            "',{detail:" +
            detail.toString() +
            "}));"
        );
    }

    static String hqFailedJs(String previewId, int sessionId) {
        org.json.JSONObject detail = new org.json.JSONObject();
        try {
            detail.put("previewId", previewId);
            detail.put("sessionId", String.valueOf(sessionId));
            detail.put("error", "hq_failed");
        } catch (Exception ignored) {
            return null;
        }
        return (
            "window.dispatchEvent(new CustomEvent('" +
            HQ_EVENT +
            "',{detail:" +
            detail.toString() +
            "}));"
        );
    }
}
