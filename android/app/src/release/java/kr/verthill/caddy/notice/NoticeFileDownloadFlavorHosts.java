package kr.verthill.caddy.notice;

/**
 * Release extra hosts: none. Preview Vercel hosts stay out of the Play APK.
 */
public final class NoticeFileDownloadFlavorHosts {
    private NoticeFileDownloadFlavorHosts() {}

    public static boolean extraAllowed(String host) {
        return false;
    }

    static String fallbackHostWhenPageUrlMissing() {
        return null;
    }
}
