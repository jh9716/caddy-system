package kr.verthill.caddy.notice;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.annotation.RequiresApi;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

/**
 * Saves allowlisted VERTHILL notice attachments into the public Downloads
 * collection. Streams the HTTP body (max 20MB); never ships the whole file over the JS bridge.
 * Uses WebView CookieManager cookies and does not expose them to JS.
 */
@CapacitorPlugin(
    name = "NoticeFileDownload",
    permissions = {
        @Permission(
            alias = "storage",
            strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }
        )
    }
)
public class NoticeFileDownloadPlugin extends Plugin {
    private static final ExecutorService DOWNLOAD_EXECUTOR =
        Executors.newSingleThreadExecutor();

    @PluginMethod
    public void download(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            if (getPermissionState("storage") != PermissionState.GRANTED) {
                requestPermissionForAlias("storage", call, "onStoragePermission");
                return;
            }
        }
        startDownload(call);
    }

    @PermissionCallback
    private void onStoragePermission(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("permission_denied", "permission_denied");
            return;
        }
        startDownload(call);
    }

    private void startDownload(PluginCall call) {
        final String path = call.getString("path", "");
        final String filename = call.getString("filename", "");
        final Bridge bridge = getBridge();
        if (bridge == null) {
            rejectDownload(call, new NoticeFileDownloadException("invalid_url", "page_url"));
            return;
        }
        // Capacitor plugin methods run on Bridge.taskHandler, not the UI thread.
        // WebView.getUrl() and CookieManager.getCookie() must be read on the UI thread.
        bridge.executeOnMainThread(
            () -> {
                String pageUrl = readWebViewUrlOnUiThread(bridge);
                String cookieHeader = "";
                try {
                    URL url = NoticeFileDownloadPolicy.buildDownloadUrl(pageUrl, path);
                    String cookie = CookieManager.getInstance().getCookie(url.toString());
                    if (cookie != null && !cookie.isEmpty()) {
                        cookieHeader = cookie;
                    }
                } catch (NoticeFileDownloadException e) {
                    rejectDownload(call, e);
                    return;
                } catch (Exception ignored) {
                    rejectDownload(call, new NoticeFileDownloadException("invalid_url", "page_url"));
                    return;
                }
                final String originPageUrl = pageUrl;
                final String cookies = cookieHeader;
                DOWNLOAD_EXECUTOR.execute(
                    () -> runDownload(call, originPageUrl, path, filename, cookies)
                );
            }
        );
    }

    private static String readWebViewUrlOnUiThread(Bridge bridge) {
        try {
            WebView webView = bridge.getWebView();
            if (webView == null) {
                return "";
            }
            String current = webView.getUrl();
            return current != null ? current : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private void runDownload(
        PluginCall call,
        String pageUrl,
        String path,
        String filename,
        String cookieHeader
    ) {
        HttpURLConnection conn = null;
        Uri pendingUri = null;
        File pendingFile = null;
        ContentResolver resolver = getContext().getContentResolver();
        try {
            String displayName = NoticeFileDownloadPolicy.sanitizeDisplayName(filename);
            String mime = NoticeFileDownloadPolicy.mimeForFileName(displayName);
            URL url = NoticeFileDownloadPolicy.buildDownloadUrl(pageUrl, path);
            conn = openAllowlistedGet(url, cookieHeader);
            int hops = 0;
            int status = conn.getResponseCode();
            while (isRedirect(status)) {
                if (hops >= NoticeFileDownloadPolicy.MAX_REDIRECTS) {
                    throw new NoticeFileDownloadException("download_failed");
                }
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                conn = null;
                url = NoticeFileDownloadPolicy.validateRedirect(url, location);
                conn = openAllowlistedGet(url, cookieHeader);
                status = conn.getResponseCode();
                hops++;
            }
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED
                || status == HttpURLConnection.HTTP_FORBIDDEN) {
                throw new NoticeFileDownloadException("unauthorized");
            }
            if (status == HttpURLConnection.HTTP_NOT_FOUND) {
                throw new NoticeFileDownloadException("not_found");
            }
            if (status == 413) {
                throw new NoticeFileDownloadException("too_large");
            }
            if (status != HttpURLConnection.HTTP_OK) {
                throw new NoticeFileDownloadException("download_failed");
            }
            long contentLength = conn.getContentLengthLong();
            if (contentLength > NoticeFileDownloadPolicy.MAX_BYTES) {
                throw new NoticeFileDownloadException("too_large");
            }
            InputStream in = conn.getInputStream();
            if (in == null) {
                throw new NoticeFileDownloadException("download_failed");
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                pendingUri = insertPendingDownload(resolver, displayName, mime);
                try (InputStream body = in; OutputStream out = resolver.openOutputStream(pendingUri)) {
                    if (out == null) {
                        throw new NoticeFileDownloadException("download_failed");
                    }
                    copyLimited(body, out);
                    out.flush();
                }
                publishPendingDownload(resolver, pendingUri);
                pendingUri = null;
            } else {
                pendingFile = uniquePublicDownloadFile(displayName);
                try (InputStream body = in; FileOutputStream out = new FileOutputStream(pendingFile)) {
                    copyLimited(body, out);
                    out.flush();
                }
                MediaScannerConnection.scanFile(
                    getContext(),
                    new String[] { pendingFile.getAbsolutePath() },
                    new String[] { mime },
                    null
                );
                pendingFile = null;
            }
            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("displayName", displayName);
            call.resolve(ret);
        } catch (NoticeFileDownloadException e) {
            cleanupFailedSave(resolver, pendingUri, pendingFile);
            rejectDownload(call, e);
        } catch (Exception ignored) {
            cleanupFailedSave(resolver, pendingUri, pendingFile);
            call.reject("download_failed", "download_failed");
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static void rejectDownload(PluginCall call, NoticeFileDownloadException e) {
        if (NoticeFileDownloadFlavorHosts.includeDebugStage()
            && e.stage != null
            && !e.stage.isEmpty()) {
            JSObject data = new JSObject();
            data.put("stage", e.stage);
            call.reject(e.code, e.code, data);
            return;
        }
        call.reject(e.code, e.code);
    }

    private static HttpURLConnection openAllowlistedGet(URL url, String cookieHeader)
        throws Exception {
        if (!"https".equalsIgnoreCase(url.getProtocol())
            || !NoticeFileDownloadPolicy.isAllowedHost(url.getHost())) {
            throw new NoticeFileDownloadException("invalid_url", "host");
        }
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        if (!(conn instanceof HttpsURLConnection)) {
            conn.disconnect();
            throw new NoticeFileDownloadException("invalid_url", "host");
        }
        conn.setInstanceFollowRedirects(false);
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(NoticeFileDownloadPolicy.CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(NoticeFileDownloadPolicy.READ_TIMEOUT_MS);
        conn.setUseCaches(false);
        conn.setDoInput(true);
        if (cookieHeader != null && !cookieHeader.isEmpty()) {
            conn.setRequestProperty("Cookie", cookieHeader);
        }
        conn.setRequestProperty("Accept", "*/*");
        conn.setRequestProperty("Referer", "https://" + url.getHost() + "/");
        return conn;
    }

    private static boolean isRedirect(int status) {
        return status == HttpURLConnection.HTTP_MOVED_PERM
            || status == HttpURLConnection.HTTP_MOVED_TEMP
            || status == HttpURLConnection.HTTP_SEE_OTHER
            || status == 307
            || status == 308;
    }

    private static void copyLimited(InputStream in, OutputStream out)
        throws Exception {
        byte[] buf = new byte[NoticeFileDownloadPolicy.COPY_BUFFER_BYTES];
        long total = 0;
        int n;
        while ((n = in.read(buf)) >= 0) {
            if (n == 0) {
                continue;
            }
            total += n;
            if (total > NoticeFileDownloadPolicy.MAX_BYTES) {
                throw new NoticeFileDownloadException("too_large");
            }
            out.write(buf, 0, n);
        }
        if (total <= 0) {
            throw new NoticeFileDownloadException("download_failed");
        }
    }

    @RequiresApi(api = Build.VERSION_CODES.Q)
    private static Uri insertPendingDownload(
        ContentResolver resolver,
        String displayName,
        String mime
    ) throws NoticeFileDownloadException {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, displayName);
        values.put(MediaStore.Downloads.MIME_TYPE, mime);
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new NoticeFileDownloadException("download_failed");
        }
        return uri;
    }

    @RequiresApi(api = Build.VERSION_CODES.Q)
    private static void publishPendingDownload(ContentResolver resolver, Uri uri)
        throws NoticeFileDownloadException {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        int updated = resolver.update(uri, values, null, null);
        if (updated <= 0) {
            throw new NoticeFileDownloadException("download_failed");
        }
    }

    private static File uniquePublicDownloadFile(String displayName)
        throws NoticeFileDownloadException {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) {
            throw new NoticeFileDownloadException("download_failed");
        }
        if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory()) {
            throw new NoticeFileDownloadException("download_failed");
        }
        File dest = new File(dir, displayName);
        if (!dest.exists()) {
            return dest;
        }
        int dot = displayName.lastIndexOf('.');
        String stem = dot > 0 ? displayName.substring(0, dot) : displayName;
        String ext = dot > 0 ? displayName.substring(dot) : "";
        for (int i = 1; i < 100; i++) {
            File next = new File(dir, stem + " (" + i + ")" + ext);
            if (!next.exists()) {
                return next;
            }
        }
        throw new NoticeFileDownloadException("download_failed");
    }

    private static void cleanupFailedSave(
        ContentResolver resolver,
        Uri pendingUri,
        File pendingFile
    ) {
        if (pendingUri != null) {
            try {
                resolver.delete(pendingUri, null, null);
            } catch (Exception ignored) {
                // Best-effort: do not leave a pending Downloads row.
            }
        }
        if (pendingFile != null && pendingFile.exists()) {
            //noinspection ResultOfMethodCallIgnored
            pendingFile.delete();
        }
    }
}
