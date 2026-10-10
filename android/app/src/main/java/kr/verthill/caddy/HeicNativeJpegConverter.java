package kr.verthill.caddy;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Locale;
import java.util.UUID;

/**
 * HEIC/HEIF → 1600 long-edge JPEG for the WebView file chooser.
 * JPEG/PNG/WEBP stay on the original picker URI. No permissions, no base64.
 */
final class HeicNativeJpegConverter {

    static final int LONG_EDGE = 1600;
    static final int JPEG_QUALITY = 82;
    static final String CACHE_DIR_NAME = "heic-jpeg";
    static final long STALE_AFTER_MS = 60L * 60L * 1000L;

    private HeicNativeJpegConverter() {}

    static boolean isImageAcceptToken(String raw) {
        if (raw == null) return false;
        String token = raw.trim().toLowerCase(Locale.US);
        if (token.isEmpty()) return false;
        if (token.equals("image/*") || token.startsWith("image/")) return true;
        return (
            token.equals(".heic") ||
            token.equals(".heif") ||
            token.equals(".jpg") ||
            token.equals(".jpeg") ||
            token.equals(".png") ||
            token.equals(".webp")
        );
    }

    static boolean isImageOnlyAccept(String[] acceptTypes) {
        if (acceptTypes == null || acceptTypes.length == 0) return false;
        boolean image = false;
        boolean other = false;
        for (String raw : acceptTypes) {
            if (raw == null || raw.trim().isEmpty()) continue;
            if (isImageAcceptToken(raw)) image = true;
            else other = true;
        }
        return image && !other;
    }

    static boolean isHeicLike(String mime, String name) {
        String type = mime == null ? "" : mime.toLowerCase(Locale.US);
        String fileName = name == null ? "" : name.toLowerCase(Locale.US);
        return (
            type.contains("heic") ||
            type.contains("heif") ||
            fileName.endsWith(".heic") ||
            fileName.endsWith(".heif")
        );
    }

    static int[] targetSize(int width, int height, int longEdge) {
        int srcW = Math.max(1, width);
        int srcH = Math.max(1, height);
        int longest = Math.max(srcW, srcH);
        if (longest <= longEdge) {
            return new int[] { srcW, srcH };
        }
        float scale = longEdge / (float) longest;
        return new int[] {
            Math.max(1, Math.round(srcW * scale)),
            Math.max(1, Math.round(srcH * scale)),
        };
    }

    static Uri resolveForWebView(Context context, Uri uri) {
        if (context == null || uri == null) return uri;
        if (!isHeicLike(mimeOf(context, uri), displayNameOf(context, uri))) {
            return uri;
        }
        Uri converted = convertHeicToJpeg(context, uri);
        return converted != null ? converted : uri;
    }

    static void cleanupStale(Context context) {
        if (context == null) return;
        File dir = new File(context.getCacheDir(), CACHE_DIR_NAME);
        File[] files = dir.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - STALE_AFTER_MS;
        for (File file : files) {
            if (file.isFile() && file.lastModified() < cutoff) {
                // Best-effort. A locked file stays until the next cleanup.
                file.delete();
            }
        }
    }

    private static Uri convertHeicToJpeg(Context context, Uri uri) {
        if (Build.VERSION.SDK_INT < 28) return null;
        File dir = new File(context.getCacheDir(), CACHE_DIR_NAME);
        if (!dir.isDirectory() && !dir.mkdirs()) return null;
        File outFile = new File(dir, UUID.randomUUID().toString() + ".jpg");
        Bitmap bitmap = null;
        try {
            ImageDecoder.Source source = ImageDecoder.createSource(context.getContentResolver(), uri);
            bitmap = ImageDecoder.decodeBitmap(source, (decoder, info, src) -> {
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                int[] sized = targetSize(info.getSize().getWidth(), info.getSize().getHeight(), LONG_EDGE);
                if (
                    sized[0] != info.getSize().getWidth() ||
                    sized[1] != info.getSize().getHeight()
                ) {
                    decoder.setTargetSize(sized[0], sized[1]);
                }
            });
            if (bitmap == null || bitmap.getWidth() < 1 || bitmap.getHeight() < 1) {
                return null;
            }
            FileOutputStream output = new FileOutputStream(outFile);
            try {
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, output)) {
                    return null;
                }
                output.flush();
            } finally {
                output.close();
            }
            if (!outFile.isFile() || outFile.length() <= 0) {
                return null;
            }
            Uri provided = FileProvider.getUriForFile(
                context,
                context.getPackageName() + ".fileprovider",
                outFile
            );
            context.grantUriPermission(
                context.getPackageName(),
                provided,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
            return provided;
        } catch (Exception ignored) {
            if (outFile.exists()) {
                outFile.delete();
            }
            return null;
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }

    private static String mimeOf(Context context, Uri uri) {
        try {
            return context.getContentResolver().getType(uri);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String displayNameOf(Context context, Uri uri) {
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(
                uri,
                new String[] { OpenableColumns.DISPLAY_NAME },
                null,
                null,
                null
            );
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
            // Fall through to the path segment.
        } finally {
            if (cursor != null) cursor.close();
        }
        return uri.getLastPathSegment();
    }
}
