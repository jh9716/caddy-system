package kr.verthill.caddy.notice;

final class NoticeFileDownloadException extends Exception {
    final String code;

    NoticeFileDownloadException(String code) {
        super(code);
        this.code = code;
    }
}
