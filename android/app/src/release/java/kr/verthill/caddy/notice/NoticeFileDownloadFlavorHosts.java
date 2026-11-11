package kr.verthill.caddy.notice;

/**
 * Release extra hosts: none. Preview Vercel hosts stay out of the Play APK.
 */
final class NoticeFileDownloadFlavorHosts {
    private NoticeFileDownloadFlavorHosts() {}

    static boolean extraAllowed(String host) {
        return false;
    }

    static String fallbackHostWhenPageUrlMissing() {
        return null;
    }
}
