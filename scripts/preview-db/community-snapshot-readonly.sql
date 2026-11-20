-- PR #380 Preview migrate 전후 비교용 지문 (읽기 전용). 개수·md5 지문만 출력, 개인정보·본문 미출력.
BEGIN TRANSACTION READ ONLY;
SELECT 'snap_user_total=' || count(*)::text FROM "User";
SELECT 'snap_user_id_fp=' || coalesce(md5(string_agg(id::text, ',' ORDER BY id)), 'empty') FROM "User";
SELECT 'snap_caddy_total=' || count(*)::text FROM "Caddy";
SELECT 'snap_caddy_id_fp=' || coalesce(md5(string_agg(id::text, ',' ORDER BY id)), 'empty') FROM "Caddy";
SELECT 'snap_comment_total=' || count(*)::text FROM "Comment";
SELECT 'snap_comment_row_fp=' || md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) FROM "Comment" t;
SELECT 'snap_thread_total=' || count(*)::text FROM "CommentThread";
SELECT 'snap_thread_row_fp=' || md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) FROM "CommentThread" t;
SELECT 'snap_free_board_post_total=' || count(*)::text FROM "FreeBoardPost";
SELECT 'snap_free_board_post_row_fp=' || md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) FROM "FreeBoardPost" t;
SELECT 'snap_free_board_photo_total=' || count(*)::text FROM "FreeBoardPhoto";
SELECT 'snap_free_board_photo_row_fp=' || md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) FROM "FreeBoardPhoto" t;
ROLLBACK;
