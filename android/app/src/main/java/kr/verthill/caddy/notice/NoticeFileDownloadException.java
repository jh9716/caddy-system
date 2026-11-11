package kr.verthill.caddy.notice;

final class NoticeFileDownloadException extends Exception {
    final String code;
    final String stage;

    NoticeFileDownloadException(String code) {
        this(code, "");
    }

    NoticeFileDownloadException(String code, String stage) {
        super(code);
        this.code = code;
        this.stage = stage == null ? "" : stage;
    }
}
