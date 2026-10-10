package kr.verthill.caddy;

import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Size;
import java.io.ByteArrayOutputStream;
import java.util.UUID;

/**
 * Instant HEIC preview only. Never the upload JPEG.
 * Uses provider loadThumbnail (~384x512) and a JPEG data URL for the WebView.
 */
final class HeicNativePreview {

    static final String EVENT = "verthill:chat-photo-native-preview";
    static final int PREVIEW_EDGE = 512;
    static final int PREVIEW_JPEG_QUALITY = 70;

    private HeicNativePreview() {}

    static final class Preview {
        final String previewId;
        final String dataUrl;
        final int width;
        final int height;
        final int bytes;
        final long previewMs;

        Preview(String previewId, String dataUrl, int width, int height, int bytes, long previewMs) {
            this.previewId = previewId;
            this.dataUrl = dataUrl;
            this.width = width;
            this.height = height;
            this.bytes = bytes;
            this.previewMs = previewMs;
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
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, PREVIEW_JPEG_QUALITY, output)) {
                return null;
            }
            byte[] jpeg = output.toByteArray();
            if (jpeg.length <= 0) return null;
            String dataUrl =
                "data:image/jpeg;base64," + Base64.encodeToString(jpeg, Base64.NO_WRAP);
            return new Preview(
                newPreviewId(sessionId),
                dataUrl,
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

}

