package kr.verthill.caddy.notice;

import java.net.URI;
import java.net.URL;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Allowlist for native notice-file downloads. Rejects arbitrary URLs,
 * tokens in URLs, and non-https hosts. Keep in sync with
 * src/lib/noticeFileNativeDownload.ts.
 */
final class NoticeFileDownloadPolicy {
    static final String[] ALLOWED_HOSTS = {"www.verthill.kr", "verthill.kr"};
    static final int MAX_BYTES = 20 * 1024 * 1024;
    static final int CONNECT_TIMEOUT_MS = 30_000;
    static final int READ_TIMEOUT_MS = 60_000;
    static final int MAX_REDIRECTS = 3;
    static final int COPY_BUFFER_BYTES = 8192;
    static final String DEFAULT_HOST = "www.verthill.kr";

    private static final Pattern PATHNAME =
        Pattern.compile("^/api/notice/([1-9][0-9]{0,9})/files/([1-9][0-9]{0,9})$");
    private static final Pattern KNOWN_EXT =
        Pattern.compile("\\.(pdf|xlsx|xls|hwpx|hwp)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern ANY_EXT = Pattern.compile("\\.[A-Za-z0-9]{1,8}$");

    private NoticeFileDownloadPolicy() {}

    static boolean isAllowedHost(String host) {
        if (host == null || host.isEmpty()) {
            return false;
        }
        String normalized = host.toLowerCase(Locale.US);
        for (String allowed : ALLOWED_HOSTS) {
            if (allowed.equals(normalized)) {
                return true;
            }
        }
        return false;
    }

    static String originHostFromPageUrl(String pageUrl) throws NoticeFileDownloadException {
        if (pageUrl == null || pageUrl.isEmpty()) {
            return DEFAULT_HOST;
        }
        URI uri;
        try {
            uri = URI.create(pageUrl);
        } catch (Exception ignored) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        String host = uri.getHost();
        if (!isAllowedHost(host)) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        int port = uri.getPort();
        if (port != -1 && port != 443) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        return host.toLowerCase(Locale.US);
    }

    static String pathnameFromPluginPath(String pathAndQuery) throws NoticeFileDownloadException {
        if (pathAndQuery == null || pathAndQuery.isEmpty()) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        if (pathAndQuery.contains("\\")
            || pathAndQuery.contains("..")
            || pathAndQuery.contains("#")
            || pathAndQuery.contains("://")
            || !pathAndQuery.startsWith("/api/notice/")) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        int q = pathAndQuery.indexOf('?');
        String pathname = q >= 0 ? pathAndQuery.substring(0, q) : pathAndQuery;
        String query = q >= 0 ? pathAndQuery.substring(q + 1) : "";
        if (!query.isEmpty() && !"download=1".equals(query)) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        Matcher matcher = PATHNAME.matcher(pathname);
        if (!matcher.matches()) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        return pathname;
    }

    static URL buildDownloadUrl(String pageUrl, String pathAndQuery)
        throws NoticeFileDownloadException {
        String host = originHostFromPageUrl(pageUrl);
        String pathname = pathnameFromPluginPath(pathAndQuery);
        try {
            return new URL("https", host, pathname + "?download=1");
        } catch (Exception ignored) {
            throw new NoticeFileDownloadException("invalid_url");
        }
    }

    static URL validateRedirect(URL current, String location)
        throws NoticeFileDownloadException {
        if (current == null || location == null || location.isEmpty()) {
            throw new NoticeFileDownloadException("download_failed");
        }
        URL next;
        try {
            next = new URL(current, location);
        } catch (Exception ignored) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        if (!"https".equalsIgnoreCase(next.getProtocol()) || next.getUserInfo() != null) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        if (!isAllowedHost(next.getHost())) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        int port = next.getPort();
        if (port != -1 && port != 443) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        String path = next.getPath() == null ? "" : next.getPath();
        if (path.startsWith("/login")) {
            throw new NoticeFileDownloadException("unauthorized");
        }
        if (!PATHNAME.matcher(path).matches()) {
            throw new NoticeFileDownloadException("download_failed");
        }
        String query = next.getQuery() == null ? "" : next.getQuery();
        if (!query.isEmpty() && !"download=1".equals(query)) {
            throw new NoticeFileDownloadException("invalid_url");
        }
        try {
            return new URL("https", next.getHost().toLowerCase(Locale.US), path + "?download=1");
        } catch (Exception ignored) {
            throw new NoticeFileDownloadException("invalid_url");
        }
    }

    static String sanitizeDisplayName(String raw) throws NoticeFileDownloadException {
        if (raw == null) {
            throw new NoticeFileDownloadException("invalid_filename");
        }
        String base = raw.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) {
            base = base.substring(slash + 1);
        }
        base = base.replace("\0", "");
        String stripped = base.replaceAll("[<>:\"|?*\\u0000-\\u001f]", "_").trim();
        String noExt = stripKnownOrAnyExt(stripped);
        String cleaned = noExt
            .replaceAll("[^\\w.\\u3131-\\u318E\\uAC00-\\uD7A3 ()_-]", "_")
            .replaceAll("_+", "_");
        if (cleaned.length() > 120) {
            cleaned = cleaned.substring(0, 120);
        }
        cleaned = cleaned.trim();
        if (cleaned.isEmpty()) {
            cleaned = "attachment";
        }
        String ext = extFromName(raw);
        if (ext == null) {
            ext = extFromName(stripped);
        }
        if (ext == null) {
            throw new NoticeFileDownloadException("invalid_filename");
        }
        return cleaned + "." + ext;
    }

    static String mimeForFileName(String filename) throws NoticeFileDownloadException {
        String ext = extFromName(filename);
        if (ext == null) {
            throw new NoticeFileDownloadException("invalid_filename");
        }
        switch (ext) {
            case "pdf":
                return "application/pdf";
            case "xlsx":
                return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "xls":
                return "application/vnd.ms-excel";
            case "hwp":
                return "application/x-hwp";
            case "hwpx":
                return "application/hwp+zip";
            default:
                throw new NoticeFileDownloadException("invalid_filename");
        }
    }

    static String extFromName(String raw) {
        if (raw == null) {
            return null;
        }
        String base = raw.replace('\\', '/');
        int slash = base.lastIndexOf('/');
        if (slash >= 0) {
            base = base.substring(slash + 1);
        }
        String lower = base.trim().toLowerCase(Locale.US);
        if (lower.endsWith(".xlsx")) {
            return "xlsx";
        }
        if (lower.endsWith(".xls")) {
            return "xls";
        }
        if (lower.endsWith(".hwpx")) {
            return "hwpx";
        }
        if (lower.endsWith(".hwp")) {
            return "hwp";
        }
        if (lower.endsWith(".pdf")) {
            return "pdf";
        }
        return null;
    }

    private static String stripKnownOrAnyExt(String name) {
        String base = name;
        for (int i = 0; i < 4; i++) {
            String next = KNOWN_EXT.matcher(base).replaceFirst("");
            if (next.equals(base)) {
                break;
            }
            base = next;
        }
        return ANY_EXT.matcher(base).replaceFirst("");
    }
}
