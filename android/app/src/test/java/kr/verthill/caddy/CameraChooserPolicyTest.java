package kr.verthill.caddy;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class CameraChooserPolicyTest {

    @Test
    public void cameraOfferedOnlyOnFreeBoardAndCommunityPages() {
        assertTrue(CameraChooserPolicy.allowsCameraForUrl("https://www.verthill.kr/talk/new"));
        assertTrue(CameraChooserPolicy.allowsCameraForUrl("https://www.verthill.kr/talk/12/edit"));
        assertTrue(CameraChooserPolicy.allowsCameraForUrl("https://www.verthill.kr/talk"));
        assertTrue(CameraChooserPolicy.allowsCameraForUrl("https://www.verthill.kr/community/new"));
        assertTrue(CameraChooserPolicy.allowsCameraForUrl("https://www.verthill.kr/community/3/edit?x=1"));
        assertFalse(CameraChooserPolicy.allowsCameraForUrl("https://www.verthill.kr/chat"));
        assertFalse(CameraChooserPolicy.allowsCameraForUrl("https://www.verthill.kr/notice/new"));
        assertFalse(CameraChooserPolicy.allowsCameraForUrl("https://www.verthill.kr/course-reports"));
        assertFalse(CameraChooserPolicy.allowsCameraForUrl("https://www.verthill.kr/talkative"));
        assertFalse(CameraChooserPolicy.allowsCameraForUrl("https://www.verthill.kr/communityx"));
        assertFalse(CameraChooserPolicy.allowsCameraForUrl(null));
        assertFalse(CameraChooserPolicy.allowsCameraForUrl(""));
        assertFalse(CameraChooserPolicy.allowsCameraForUrl("::not a url"));
    }

    @Test
    public void cancelWhenResultNotOk() {
        assertEquals(CameraChooserPolicy.Source.CANCEL, CameraChooserPolicy.decide(false, 3, false, 100));
        assertEquals(CameraChooserPolicy.Source.CANCEL, CameraChooserPolicy.decide(false, 0, false, 100));
    }

    @Test
    public void galleryOrFilesResultWins() {
        assertEquals(CameraChooserPolicy.Source.PICKED, CameraChooserPolicy.decide(true, 1, false, 0));
        assertEquals(CameraChooserPolicy.Source.PICKED, CameraChooserPolicy.decide(true, 9, false, 0));
        // Empty camera temp file left over while the user picked from the gallery.
        assertEquals(CameraChooserPolicy.Source.PICKED, CameraChooserPolicy.decide(true, 2, false, 0));
    }

    @Test
    public void cameraResultUsesOutputFile() {
        // Most camera apps return no data when EXTRA_OUTPUT is set.
        assertEquals(CameraChooserPolicy.Source.CAMERA, CameraChooserPolicy.decide(true, 0, false, 2048));
        // Some camera apps echo the EXTRA_OUTPUT URI back.
        assertEquals(CameraChooserPolicy.Source.CAMERA, CameraChooserPolicy.decide(true, 1, true, 2048));
    }

    @Test
    public void emptyCameraFileIsCancel() {
        assertEquals(CameraChooserPolicy.Source.CANCEL, CameraChooserPolicy.decide(true, 0, false, 0));
        assertEquals(CameraChooserPolicy.Source.CANCEL, CameraChooserPolicy.decide(true, 1, true, 0));
    }

    @Test
    public void cameraFileNameIsJpeg() {
        assertEquals("VERTHILL_123.jpg", CameraChooserPolicy.cameraFileName(123L));
    }

    @Test
    public void staleAfterOneDay() {
        long now = 10L * CameraChooserPolicy.CAMERA_STALE_AFTER_MS;
        assertTrue(CameraChooserPolicy.isStale(now - CameraChooserPolicy.CAMERA_STALE_AFTER_MS - 1, now));
        assertFalse(CameraChooserPolicy.isStale(now - 1000, now));
    }
}
