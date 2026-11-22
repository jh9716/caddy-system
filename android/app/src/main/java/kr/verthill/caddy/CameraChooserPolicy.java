package kr.verthill.caddy;

import java.net.URI;

/**
 * Pure (Android-free) rules for the in-app photo chooser camera option.
 * Kept separate so it can be unit-tested on the JVM.
 */
final class CameraChooserPolicy {

    /** Dedicated cache subdirectory for camera captures (FileProvider cache-path "camera-capture/"). */
    static final String CAMERA_DIR_NAME = "camera-capture";
    /** Camera temp files older than this are removed when a new chooser opens. */
    static final long CAMERA_STALE_AFTER_MS = 24L * 60L * 60L * 1000L;

    /** Pages whose "+ 사진" chooser also offers the camera: 자유게시판(/talk) and 가배치표(/community). */
    private static final String[] CAMERA_PATH_PREFIXES = { "/talk", "/community" };

    enum Source {
        /** Use URIs returned by the gallery / file app. */
        PICKED,
        /** Use the camera output file. */
        CAMERA,
        /** Nothing usable: deliver null (cancel) to the WebView. */
        CANCEL,
    }

    private CameraChooserPolicy() {}

    /** True when the current page should offer the camera next to gallery / files. */
    static boolean allowsCameraForUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        String path;
        try {
            path = new URI(url).getPath();
        } catch (Exception e) {
            return false;
        }
        if (path == null) return false;
        for (String prefix : CAMERA_PATH_PREFIXES) {
            if (path.equals(prefix) || path.startsWith(prefix + "/")) return true;
        }
        return false;
    }

    /**
     * Decide which result to hand to the WebView.
     *
     * @param resultOk activity result was RESULT_OK
     * @param pickedCount number of URIs found in the result intent (data / ClipData)
     * @param pickedIsCameraOnly the only returned URI is the camera output URI itself
     * @param cameraFileBytes size of the camera temp file (0 when absent or empty)
     */
    static Source decide(boolean resultOk, int pickedCount, boolean pickedIsCameraOnly, long cameraFileBytes) {
        if (!resultOk) return Source.CANCEL;
        if (pickedCount > 0 && !pickedIsCameraOnly) return Source.PICKED;
        if (cameraFileBytes > 0) return Source.CAMERA;
        return Source.CANCEL;
    }

    /** Camera file name used for the FileProvider URI; the .jpg suffix gives the WebView image/jpeg. */
    static String cameraFileName(long nowMs) {
        return "VERTHILL_" + nowMs + ".jpg";
    }

    static boolean isStale(long lastModifiedMs, long nowMs) {
        return lastModifiedMs < nowMs - CAMERA_STALE_AFTER_MS;
    }
}
