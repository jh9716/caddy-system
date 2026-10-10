package kr.verthill.caddy;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.provider.OpenableColumns;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Locale;
import java.util.UUID;

/**
 * HEIC/HEIF → 1600 long-edge JPEG for the WebView file chooser.
 *
 * Fast path: BitmapFactory FileDescriptor + power-of-two inSampleSize.
 * Fallback: ImageDecoder setTargetSampleSize, then web heic-to.
 * Provider thumbs are never the upload file. JPEG/PNG/WEBP stay on the picker URI.
 * No permissions, no base64.
 */
final class HeicNativeJpegConverter {

    static final int LONG_EDGE = 1600;
    static final int JPEG_QUALITY = 82;
    static final String CACHE_DIR_NAME = "heic-jpeg";
    static final long STALE_AFTER_MS = 60L * 60L * 1000L;

    static final String PATH_BITMAP = "bitmap";
    static final String PATH_DECODER_SAMPLED = "decoder-sampled";
    static final String PATH_WEB = "web";
    static final String PATH_PASSTHROUGH = "passthrough";

    private HeicNativeJpegConverter() {}

    static final class ConvertResult {
        final Uri uri;
        final String path;
        final long boundsMs;
        final long decodeMs;
        final long rotateMs;
        final long scaleMs;
        final long jpegMs;
        final long totalNativeMs;
        final int outputWidth;
        final int outputHeight;
        final long outputBytes;

        ConvertResult(
            Uri uri,
            String path,
            long boundsMs,
            long decodeMs,
            long rotateMs,
            long scaleMs,
            long jpegMs,
            long totalNativeMs,
            int outputWidth,
            int outputHeight,
            long outputBytes
        ) {
            this.uri = uri;
            this.path = path;
            this.boundsMs = boundsMs;
            this.decodeMs = decodeMs;
            this.rotateMs = rotateMs;
            this.scaleMs = scaleMs;
            this.jpegMs = jpegMs;
            this.totalNativeMs = totalNativeMs;
            this.outputWidth = outputWidth;
            this.outputHeight = outputHeight;
            this.outputBytes = outputBytes;
        }

        boolean shouldToast() {
            return (
                PATH_BITMAP.equals(path) ||
                PATH_DECODER_SAMPLED.equals(path) ||
                PATH_WEB.equals(path)
            );
        }

        String debugMessage() {
            if (PATH_WEB.equals(path)) {
                return "HEIC native FAIL → web";
            }
            String label = PATH_BITMAP.equals(path) ? "HEIC bitmap" : "HEIC decoder-sampled";
            return (
                label +
                " · bounds " +
                boundsMs +
                "ms · decode " +
                decodeMs +
                "ms · rotate " +
                rotateMs +
                "ms · scale " +
                scaleMs +
                "ms · jpeg " +
                jpegMs +
                "ms · total " +
                totalNativeMs +
                "ms · " +
                outputWidth +
                "x" +
                outputHeight +
                " · " +
                Math.max(0, Math.round(outputBytes / 1024.0)) +
                "KB"
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

    /**
     * Largest power-of-two sample that keeps the decoded long edge >= 1600
     * when the source is larger. Never samples below 1600 when avoidable.
     */
    static int powerOfTwoSampleSize(int width, int height, int longEdge) {
        int longest = Math.max(Math.max(1, width), Math.max(1, height));
        if (longest <= longEdge) return 1;
        int sample = 1;
        while (longest / (sample * 2) >= longEdge) {
            sample *= 2;
        }
        return sample;
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

    static Bitmap applyExifOrientation(Bitmap src, int orientation) {
        if (src == null) return null;
        Matrix matrix = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:
                matrix.setScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_180:
                matrix.setRotate(180f);
                break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL:
                matrix.setScale(1f, -1f);
                break;
            case ExifInterface.ORIENTATION_TRANSPOSE:
                matrix.setRotate(90f);
                matrix.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_90:
                matrix.setRotate(90f);
                break;
            case ExifInterface.ORIENTATION_TRANSVERSE:
                matrix.setRotate(-90f);
                matrix.postScale(-1f, 1f);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270:
                matrix.setRotate(270f);
                break;
            default:
                return src;
        }
        Bitmap rotated = Bitmap.createBitmap(
            src,
            0,
            0,
            src.getWidth(),
            src.getHeight(),
            matrix,
            true
        );
        if (rotated != src) {
            src.recycle();
        }
        return rotated;
    }

    static ConvertResult resolveForWebView(Context context, Uri uri) {
        if (context == null || uri == null) {
            return passthrough(uri);
        }
        if (!isHeicLike(mimeOf(context, uri), displayNameOf(context, uri))) {
            return passthrough(uri);
        }
        long started = SystemClock.elapsedRealtime();
        ConvertResult bitmapPath = tryBitmapFactory(context, uri);
        if (bitmapPath != null) {
            return withTotal(bitmapPath, SystemClock.elapsedRealtime() - started);
        }
        ConvertResult decoded = tryImageDecoderSampled(context, uri);
        if (decoded != null) {
            return withTotal(decoded, SystemClock.elapsedRealtime() - started);
        }
        return new ConvertResult(
            uri,
            PATH_WEB,
            0L,
            0L,
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
        return new ConvertResult(uri, PATH_PASSTHROUGH, 0L, 0L, 0L, 0L, 0L, 0L, 0, 0, 0L);
    }

    private static ConvertResult withTotal(ConvertResult result, long totalNativeMs) {
        return new ConvertResult(
            result.uri,
            result.path,
            result.boundsMs,
            result.decodeMs,
            result.rotateMs,
            result.scaleMs,
            result.jpegMs,
            totalNativeMs,
            result.outputWidth,
            result.outputHeight,
            result.outputBytes
        );
    }

    private static ConvertResult tryBitmapFactory(Context context, Uri uri) {
        File outFile = createJpegFile(context);
        if (outFile == null) return null;
        Bitmap bitmap = null;
        try {
            long boundsStarted = SystemClock.elapsedRealtime();
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            ParcelFileDescriptor boundsPfd = context.getContentResolver().openFileDescriptor(uri, "r");
            if (boundsPfd == null) return null;
            try {
                BitmapFactory.decodeFileDescriptor(boundsPfd.getFileDescriptor(), null, bounds);
            } finally {
                boundsPfd.close();
            }
            long boundsMs = SystemClock.elapsedRealtime() - boundsStarted;
            if (bounds.outWidth < 1 || bounds.outHeight < 1) {
                deleteQuietly(outFile);
                return null;
            }

            int orientation = readExifOrientation(context, uri);
            int sample = powerOfTwoSampleSize(bounds.outWidth, bounds.outHeight, LONG_EDGE);

            long decodeStarted = SystemClock.elapsedRealtime();
            BitmapFactory.Options decode = new BitmapFactory.Options();
            decode.inJustDecodeBounds = false;
            decode.inSampleSize = sample;
            decode.inPreferredConfig = Bitmap.Config.ARGB_8888;
            ParcelFileDescriptor decodePfd = context.getContentResolver().openFileDescriptor(uri, "r");
            if (decodePfd == null) {
                deleteQuietly(outFile);
                return null;
            }
            try {
                bitmap = BitmapFactory.decodeFileDescriptor(
                    decodePfd.getFileDescriptor(),
                    null,
                    decode
                );
            } finally {
                decodePfd.close();
            }
            long decodeMs = SystemClock.elapsedRealtime() - decodeStarted;
            if (bitmap == null || bitmap.getWidth() < 1 || bitmap.getHeight() < 1) {
                deleteQuietly(outFile);
                return null;
            }

            long rotateStarted = SystemClock.elapsedRealtime();
            bitmap = applyExifOrientation(bitmap, orientation);
            long rotateMs = SystemClock.elapsedRealtime() - rotateStarted;
            if (bitmap == null || bitmap.getWidth() < 1 || bitmap.getHeight() < 1) {
                deleteQuietly(outFile);
                return null;
            }

            long scaleStarted = SystemClock.elapsedRealtime();
            bitmap = downscaleIfNeeded(bitmap, LONG_EDGE);
            long scaleMs = SystemClock.elapsedRealtime() - scaleStarted;
            if (bitmap == null || bitmap.getWidth() < 1 || bitmap.getHeight() < 1) {
                deleteQuietly(outFile);
                return null;
            }

            return compressToFile(
                context,
                outFile,
                bitmap,
                PATH_BITMAP,
                boundsMs,
                decodeMs,
                rotateMs,
                scaleMs
            );
        } catch (Exception ignored) {
            deleteQuietly(outFile);
            return null;
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }

    private static ConvertResult tryImageDecoderSampled(Context context, Uri uri) {
        if (Build.VERSION.SDK_INT < 28) return null;
        File outFile = createJpegFile(context);
        if (outFile == null) return null;
        Bitmap bitmap = null;
        try {
            long decodeStarted = SystemClock.elapsedRealtime();
            ImageDecoder.Source source = ImageDecoder.createSource(context.getContentResolver(), uri);
            bitmap = ImageDecoder.decodeBitmap(source, (decoder, info, src) -> {
                decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                int sample = powerOfTwoSampleSize(
                    info.getSize().getWidth(),
                    info.getSize().getHeight(),
                    LONG_EDGE
                );
                if (sample > 1) {
                    decoder.setTargetSampleSize(sample);
                }
            });
            long decodeMs = SystemClock.elapsedRealtime() - decodeStarted;
            if (bitmap == null || bitmap.getWidth() < 1 || bitmap.getHeight() < 1) {
                deleteQuietly(outFile);
                return null;
            }

            long scaleStarted = SystemClock.elapsedRealtime();
            bitmap = downscaleIfNeeded(bitmap, LONG_EDGE);
            long scaleMs = SystemClock.elapsedRealtime() - scaleStarted;
            if (bitmap == null || bitmap.getWidth() < 1 || bitmap.getHeight() < 1) {
                deleteQuietly(outFile);
                return null;
            }

            return compressToFile(
                context,
                outFile,
                bitmap,
                PATH_DECODER_SAMPLED,
                0L,
                decodeMs,
                0L,
                scaleMs
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
        long boundsMs,
        long decodeMs,
        long rotateMs,
        long scaleMs
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
            long jpegMs = SystemClock.elapsedRealtime() - jpegStarted;
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
                boundsMs,
                decodeMs,
                rotateMs,
                scaleMs,
                jpegMs,
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

    private static int readExifOrientation(Context context, Uri uri) {
        ParcelFileDescriptor pfd = null;
        try {
            pfd = context.getContentResolver().openFileDescriptor(uri, "r");
            if (pfd == null) return ExifInterface.ORIENTATION_NORMAL;
            ExifInterface exif = new ExifInterface(pfd.getFileDescriptor());
            return exif.getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL
            );
        } catch (Exception ignored) {
            return ExifInterface.ORIENTATION_NORMAL;
        } finally {
            if (pfd != null) {
                try {
                    pfd.close();
                } catch (Exception ignored) {
                    // Ignore close errors after a successful read.
                }
            }
        }
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
