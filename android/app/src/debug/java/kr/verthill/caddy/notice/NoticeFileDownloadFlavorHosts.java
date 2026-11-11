package kr.verthill.caddy.notice;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Debug-only extra hosts for notice-file download. Release has a no-op twin.
 * Keep in sync with src/lib/androidDebugPreviewHost.ts.
 */
public final class NoticeFileDownloadFlavorHosts {
    private static final Pattern PREVIEW_GIT =
        Pattern.compile(
            "^caddy-system-gt8t-git-[a-z0-9-]{1,80}-jh9716s-projects\\.vercel\\.app$"
        );
    private static final Pattern PREVIEW_DPL =
        Pattern.compile(
            "^caddy-system-gt8t-[a-z0-9]{8,20}-jh9716s-projects\\.vercel\\.app$"
        );

    private NoticeFileDownloadFlavorHosts() {}

    public static boolean extraAllowed(String host) {
        if (host == null || host.isEmpty()) {
            return false;
        }
        String normalized = host.toLowerCase(Locale.US);
        if ("caddy-system-gt8t.vercel.app".equals(normalized)
            || "caddy-system-gt8t-jh9716s-projects.vercel.app".equals(normalized)
            || "caddy-system-gt8t-git-main-jh9716s-projects.vercel.app".equals(normalized)) {
            return false;
        }
        return PREVIEW_GIT.matcher(normalized).matches()
            || PREVIEW_DPL.matcher(normalized).matches();
    }

    /** Empty page URL must not fall back to production from a Preview debug APK. */
    static String fallbackHostWhenPageUrlMissing() {
        return "";
    }
}
