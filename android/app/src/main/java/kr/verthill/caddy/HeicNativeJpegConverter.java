package kr.verthill.caddy;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Size;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Locale;
import java.util.UUID;

/**
 * HEIC/HEIF → 1600 long-edge JPEG for the WebView file chooser.
 *
 * API 29+: ContentResolver.loadThumbnail first, then ImageDecoder, then the
 * original HEIC URI (JS heic-to). JPEG/PNG/WEBP stay on the picker URI.
 * No permissions, no base64.
 */
final class HeicNativeJpegConverter {

    static final int LONG_EDGE = 1600;
    static final int JPEG_QUALITY = 82;
    static final String CACHE_DIR_NAME = "heic-jpeg";
    static final long STALE_AFTER_MS = 60L * 60L * 1000L;

    static final String PATH_THUMBNAIL = "thumbnail";
    static final String PATH_IMAGEDECODER = "imagedecoder";
    static final String PATH_WEB = "web";
    static final String PATH_PASSTHROUGH = "passthrough";

    private HeicNativeJpegConverter() {}

    static final class ConvertResult {
        final Uri uri;
        final String path;
        final long thumbnailMs;
        final long decoderMs;
        final long jpegCompressMs;
        final long totalNativeMs;
        final int outputWidth;
        final int outputHeight;
        final long outputBytes;

        ConvertResult(
            Uri uri,
            String path,
            long thumbnailMs,
            long decoderMs,
            long jpegCompressMs,
            long totalNativeMs,
            int outputWidth,
            int outputHeight,
            long outputBytes
        ) {
            this.uri = uri;
            this.path = path;
            this.thumbnailMs = thumbnailMs;
            this.decoderMs = decoderMs;
            this.jpegCompressMs = jpegCompressMs;
            this.totalNativeMs = totalNativeMs;
            this.outputWidth = outputWidth;
            this.outputHeight = outputHeight;
            this.outputBytes = outputBytes;
        }

        boolean shouldToast() {
            return (
                PATH_THUMBNAIL.equals(path) ||
                PATH_IMAGEDECODER.equals(path) ||
                PATH_WEB.equals(path)
            );
        }

        String debugMessage() {
            if (PATH_WEB.equals(path)) {
                return "HEIC native FAIL → web";
            }
            String size = outputWidth + "x" + outputHeight;
            String kb = Math.max(0, Math.round(outputBytes / 1024.0)) + "KB";
            if (PATH_THUMBNAIL.equals(path)) {
                return (
                    "HEIC thumb OK · " +
                    thumbnailMs +
                    "ms · " +
                    size +
                    " · " +
                    kb +
                    " · jpeg " +
                    jpegCompressMs +
                    "ms · total " +
                    totalNativeMs +
                    "ms"
                );
            }
            return (
                "HEIC decoder · " +
                decoderMs +
                "ms · " +
                size +
                " · jpeg " +
                jpegCompressMs +
                "ms · total " +
                totalNativeMs +
                "ms"
            );
        }
    }

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

    static Size thumbnailRequestSize(int width, int height) {
        int[] sized = targetSize(width, height, LONG_EDGE);
        return new Size(sized[0], sized[1]);
    }

    /**
     * Never upscale. Only shrink when the long edge is above 1600.
     */
    static Bitmap downscaleIfNeeded(Bitmap src, int longEdge) {
        if (src == null) return null;
        int width = src.getWidth();
        int height = src.getHeight();
        if (width < 1 || height < 1) return src;
        if (Math.max(width, height) <= longEdge) {
            return src;
        }
        int[] sized = targetSize(width, height, longEdge);
        Bitmap scaled = Bitmap.createScaledBitmap(src, sized[0], sized[1], true);
        if (scaled != src) {
            src.recycle();
        }
        return scaled;
    }

    static ConvertResult resolveForWebView(Context context, Uri uri) {
        if (context == null || uri == null) {
            return passthrough(uri);
        }
        if (!isHeicLike(mimeOf(context, uri), displayNameOf(context, uri))) {
            return passthrough(uri);
        }
        long started = SystemClock.elapsedRealtime();
        ConvertResult thumb = tryLoadThumbnail(context, uri);
        if (thumb != null) {
            return withTotal(thumb, SystemClock.elapsedRealtime() - started);
        }
        ConvertResult decoded = tryImageDecoder(context, uri);
        if (decoded != null) {
            return withTotal(decoded, SystemClock.elapsedRealtime() - started);
        }
        return new ConvertResult(
            uri,
            PATH_WEB,
            0L,
            0L,
            0L,
            SystemClock.elapsedRealtime() - started,
            0,
            0,
            0L
        );
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

    private static ConvertResult passthrough(Uri uri) {
        return new ConvertResult(uri, PATH_PASSTHROUGH, 0L, 0L, 0L, 0L, 0, 0, 0L);
    }

    private static ConvertResult withTotal(ConvertResult result, long totalNativeMs) {
        return new ConvertResult(
            result.uri,
            result.path,
            result.thumbnailMs,
            result.decoderMs,
            result.jpegCompressMs,
            totalNativeMs,
            result.outputWidth,
            result.outputHeight,
            result.outputBytes
        );
    }

    private static ConvertResult tryLoadThumbnail(Context context, Uri uri) {
        if (Build.VERSION.SDK_INT < 29) return null;
        File outFile = createJpegFile(context);
        if (outFile == null) return null;
        Bitmap bitmap = null;
        long thumbStarted = SystemClock.elapsedRealtime();
        long thumbnailMs = 0L;
        try {
            Size request = thumbnailRequestFor(context, uri);
            bitmap = context.getContentResolver().loadThumbnail(uri, request, null);
            thumbnailMs = SystemClock.elapsedRealtime() - thumbStarted;
            if (bitmap == null || bitmap.getWidth() < 1 || bitmap.getHeight() < 1) {
                return null;
            }
            bitmap = downscaleIfNeeded(bitmap, LONG_EDGE);
            if (bitmap == null || bitmap.getWidth() < 1 || bitmap.getHeight() < 1) {
                return null;
            }
            return compressToFile(
                context,
                outFile,
                bitmap,
                PATH_THUMBNAIL,
                thumbnailMs,
                0L
            );
        } catch (Exception ignored) {
            deleteQuietly(outFile);
            return null;
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }

    private static ConvertResult tryImageDecoder(Context context, Uri uri) {
        if (Build.VERSION.SDK_INT < 28) return null;
        File outFile = createJpegFile(context);
        if (outFile == null) return null;
        Bitmap bitmap = null;
        long decodeStarted = SystemClock.elapsedRealtime();
        long decoderMs = 0L;
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
            decoderMs = SystemClock.elapsedRealtime() - decodeStarted;
            if (bitmap == null || bitmap.getWidth() < 1 || bitmap.getHeight() < 1) {
                return null;
            }
            return compressToFile(
                context,
                outFile,
                bitmap,
                PATH_IMAGEDECODER,
                0L,
                decoderMs
            );
        } catch (Exception ignored) {
            deleteQuietly(outFile);
            return null;
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }

    private static ConvertResult compressToFile(
        Context context,
        File outFile,
        Bitmap bitmap,
        String path,
        long thumbnailMs,
        long decoderMs
    ) {
        long jpegStarted = SystemClock.elapsedRealtime();
        try {
            FileOutputStream output = new FileOutputStream(outFile);
            try {
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, output)) {
                    deleteQuietly(outFile);
                    return null;
                }
                output.flush();
            } finally {
                output.close();
            }
            long jpegCompressMs = SystemClock.elapsedRealtime() - jpegStarted;
            if (!outFile.isFile() || outFile.length() <= 0) {
                deleteQuietly(outFile);
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
            return new ConvertResult(
                provided,
                path,
                thumbnailMs,
                decoderMs,
                jpegCompressMs,
                0L,
                bitmap.getWidth(),
                bitmap.getHeight(),
                outFile.length()
            );
        } catch (Exception ignored) {
            deleteQuietly(outFile);
            return null;
        }
    }

    private static Size thumbnailRequestFor(Context context, Uri uri) {
        int[] probed = probeSourceSize(context, uri);
        if (probed != null) {
            return thumbnailRequestSize(probed[0], probed[1]);
        }
        return new Size(LONG_EDGE, LONG_EDGE);
    }

    private static int[] probeSourceSize(Context context, Uri uri) {
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(
                uri,
                new String[] { MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT },
                null,
                null,
                null
            );
            if (cursor != null && cursor.moveToFirst()) {
                int widthIndex = cursor.getColumnIndex(MediaStore.MediaColumns.WIDTH);
                int heightIndex = cursor.getColumnIndex(MediaStore.MediaColumns.HEIGHT);
                if (widthIndex >= 0 && heightIndex >= 0) {
                    int width = cursor.getInt(widthIndex);
                    int height = cursor.getInt(heightIndex);
                    if (width > 0 && height > 0) {
                        return new int[] { width, height };
                    }
                }
            }
        } catch (Exception ignored) {
            // Unknown size: request 1600x1600 and keep the provider aspect ratio.
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    private static File createJpegFile(Context context) {
        File dir = new File(context.getCacheDir(), CACHE_DIR_NAME);
        if (!dir.isDirectory() && !dir.mkdirs()) return null;
        return new File(dir, UUID.randomUUID().toString() + ".jpg");
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) {
            file.delete();
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
