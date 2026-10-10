package kr.verthill.caddy;

import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Size;
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

    static String newPreviewId(int sessionId) {
        return "nvp-" + sessionId + "-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    }

    static Preview tryPreview(Context context, Uri uri, int sessionId) {
        if (context == null || uri == null) return null;
        if (Build.VERSION.SDK_INT < 29) return null;
        if (!HeicNativeJpegConverter.isHeicLike(
            HeicNativeJpegConverter.mimeOf(context, uri),
            HeicNativeJpegConverter.displayNameOf(context, uri)
        )) {
            return null;
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
                return null;
            }
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, PREVIEW_JPEG_QUALITY, output)) {
                return null;
            }
            byte[] jpeg = output.toByteArray();
            if (jpeg.length <= 0) return null;
            return new Preview(
                newPreviewId(sessionId),
                jpeg,
                bitmap.getWidth(),
                bitmap.getHeight(),
                jpeg.length,
                SystemClock.elapsedRealtime() - started
            );
        } catch (Exception ignored) {
            return null;
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
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
